import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpProvisioningService } from '../erpnext/provisioning.service';

// ─────────────────────────────────────────────────────────────────────────
// Stripe webhook processing (Phase 1).
//
// Contract (Option C split): the PORTAL creates Customers / Checkout
// Sessions; bgc-api is the ONLY place subscription state is confirmed.
// The portal never queries Stripe for status.
//
// Idempotency: every event is inserted into StripeEvent (unique eventId)
// BEFORE any handler runs. A P2002 on that insert = already processed →
// return 200. Stripe retries any non-2xx, so this must hold under replay.
//
// Phase 2 (TODO): on subscription 'active', provision the ERPNext Company
// + template CoA (spike recipe) and link clientId on StripeSubscription.
// ─────────────────────────────────────────────────────────────────────────
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly provisioning: ErpProvisioningService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set — Stripe module cannot start');
    }
    // No explicit apiVersion: the SDK pins its own default to match its types.
    this.stripe = new Stripe(key, { typescript: true });
  }

  async handle(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new InternalServerErrorException('STRIPE_WEBHOOK_SECRET is not set');
    }
    if (!rawBody || !signature) {
      throw new BadRequestException('Missing raw body or stripe-signature header');
    }

    // Verify BEFORE touching the database — signature failure = 400, so
    // Stripe keeps retrying instead of treating it as processed.
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (err) {
      this.logger.warn(`Signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid Stripe signature');
    }

    // Dedupe: insert-first, unique eventId.
    try {
      await this.prisma.stripeEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          payload: event.data.object as object,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.log(`Duplicate Stripe event ${event.id} (${event.type}) — already processed`);
        return { received: true, duplicate: true };
      }
      throw err;
    }

    try {
      await this.dispatch(event);
    } catch (err) {
      // Handler failure after dedupe insert: the event row exists, so a
      // Stripe retry would be treated as a duplicate and never re-run.
      // Delete the row so the retry (or a manual replay) can process it.
      await this.prisma.stripeEvent
        .delete({ where: { eventId: event.id } })
        .catch(() => undefined);
      throw err;
    }

    this.logger.log(`Processed Stripe event ${event.id} (${event.type})`);
    return { received: true };
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.onSubscriptionChange(event.data.object);
        return;

      case 'invoice.paid':
        await this.onInvoicePaid(event.data.object);
        return;

      case 'invoice.payment_failed':
        await this.onInvoicePaymentFailed(event.data.object);
        return;

      case 'checkout.session.completed':
        // Subscription state arrives via customer.subscription.* events;
        // logged for observability (Phase 2 may hook provisioning here).
        this.logger.log('checkout.session.completed received');
        return;

      default:
        // Unknown types are already persisted in StripeEvent — 200 so
        // Stripe stops retrying; add types to the switch as needed.
        this.logger.log(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  private toNullableDate(value: number | Date | null | undefined): Date | null {
    if (value == null) return null;
    return value instanceof Date ? value : new Date(value * 1000);
  }

  // 2025 API: Invoice.subscription no longer exists — the subscription
  // reference moved to parent.subscription_details.subscription.
  private invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    const sub = invoice.parent?.subscription_details?.subscription;
    if (!sub) return null;
    return typeof sub === 'string' ? sub : sub.id;
  }

  private async onSubscriptionChange(sub: Stripe.Subscription): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const item = sub.items.data[0];
    const priceId = item?.price?.id ?? null;
    // 2025 API: period boundaries live on the subscription ITEM, not the
    // Subscription. Single-item subscriptions have exactly one item.
    const currentPeriodEnd = item?.current_period_end
      ? new Date(item.current_period_end * 1000)
      : null;
    const portalUserId = sub.metadata?.portalUserId ?? null;

    const data = {
      stripeCustomerId: customerId,
      status: sub.status,
      priceId,
      currentPeriodEnd,
      canceledAt: this.toNullableDate(sub.canceled_at),
      // Never clobber a known portalUserId with null if metadata is absent.
      ...(portalUserId ? { portalUserId } : {}),
    };

    // Keyed by CUSTOMER, not subscription id: resubscribing creates a NEW
    // subscription id for the SAME customer. Upserting on subscription id
    // would attempt an insert and collide with the stripeCustomerId unique
    // constraint (P2002). One row per customer, refreshed in place — the
    // update also re-points stripeSubscriptionId so the invoice handlers
    // (updateMany by subscription id) keep matching after a resubscribe.
    const record = await this.prisma.stripeSubscription.upsert({
      where: { stripeCustomerId: customerId },
      create: { stripeSubscriptionId: sub.id, portalUserId, ...data },
      update: { stripeSubscriptionId: sub.id, ...data },
    });

    // ── Phase 2: ERPNext provisioning ──────────────────────────────
    // First activation provisions the tenant + Company; cancel flips to
    // cancel-and-retain offboarding; resubscribe re-enables. Idempotent.
    if (['active', 'trialing'].includes(record.status)) {
      if (!record.clientId) {
        const customer = await this.stripe.customers.retrieve(customerId);
        if (!(customer as { deleted?: boolean }).deleted) {
          const { name, email } = customer as Stripe.Customer;
          const clientId = await this.provisioning.provisionForSubscription(
            {
              stripeSubscriptionId: record.stripeSubscriptionId,
              stripeCustomerId: customerId,
              portalUserId: record.portalUserId,
            },
            { name: name ?? null, email: email ?? null },
          );
          await this.prisma.stripeSubscription.update({ where: { id: record.id }, data: { clientId } });
          this.logger.log('Linked subscription ' + sub.id + ' → client ' + clientId);
        }
      } else {
        // Resubscribe after cancel: re-enable the existing tenant.
        await this.provisioning.setBookkeepingEnabled(record.clientId, true);
      }
    } else if (record.status === 'canceled' && record.clientId) {
      await this.provisioning.setBookkeepingEnabled(record.clientId, false);
    }

    this.logger.log(
      `Subscription ${sub.id} → ${sub.status} (customer ${customerId}, user ${record.portalUserId ?? 'unknown'})`,
    );
  }

  private async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.invoiceSubscriptionId(invoice);
    if (!subscriptionId) return; // one-off invoice, not subscription billing

    // Best-effort: subscription.* events remain the canonical status source.
    await this.prisma.stripeSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { status: 'active' },
    });
  }

  private async onInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.invoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    await this.prisma.stripeSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { status: 'past_due' },
    });
  }
}
