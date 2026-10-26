import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from './erpnext-platform.service';

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — ERPNext provisioning on the subscription lifecycle.
//
// subscription created/active + no linked Client → provision:
//   Client (tenant registry) + Company (ERPNext auto-creates the standard
//   CoA with " - ABBR" suffixes) + portal-user mirror for membership FKs.
// canceled → offboard: cancel-and-retain (disable Company, flip Client
//   flags). Resubscribe → re-enable. All paths idempotent.
//
// Recovery: provisioning failures rethrow → the webhook handler deletes
// its dedupe row → Stripe retries with backoff (up to ~3 days). Failed
// attempts (nothing posted) clean up via Company delete.
//
// bgc-api's TenantGuard remains the PRIMARY tenant enforcement; ERPNext's
// submit-time validation is the second line (spike finding).
// ─────────────────────────────────────────────────────────────────────────
@Injectable()
export class ErpProvisioningService {
  private readonly logger = new Logger(ErpProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpPlatformService,
  ) {}

  /** Stable short abbreviation for ERPNext account suffixes (≤5 chars). */
  private abbrFor(name: string): string {
    const abbr = name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 5);
    return abbr || 'BGC';
  }

  /** URL-safe tenant slug; the customer-id tail guarantees uniqueness. */
  private slugFor(name: string, email: string, stripeCustomerId: string): string {
    const base =
      (name || email.split('@')[0] || 'client')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'client';
    return base + '-' + stripeCustomerId.slice(-4).toLowerCase();
  }

  /**
   * Provisions the tenant for a newly-active subscription. Returns the
   * bgc-api Client id (stored on StripeSubscription.clientId).
   */
  async provisionForSubscription(
    sub: { stripeSubscriptionId: string; stripeCustomerId: string; portalUserId: string | null },
    customer: { name: string | null; email: string | null },
  ): Promise<string> {
    const companyName = (customer.name || customer.email || 'Client').slice(0, 100);
    const abbr = this.abbrFor(companyName);
    const email = customer.email || 'unknown+' + sub.stripeCustomerId + '@example.invalid';
    const slug = this.slugFor(customer.name || '', email, sub.stripeCustomerId);

    // Idempotency: a retry after a partially-failed run reuses the row.
    const existing = await this.prisma.client.findFirst({
      where: { stripeSubscription: { stripeCustomerId: sub.stripeCustomerId } },
    });
    if (existing) return existing.id;

    const client = await this.prisma.client.create({
      data: {
        slug,
        name: companyName,
        legalName: companyName,
        email,
        erpCompanyName: companyName,
        bookkeepingEnabled: false, // flipped on after the Company exists
      },
    });
    const job = await this.prisma.provisioningJob.create({
      data: { clientId: client.id, state: 'queued' },
    });

    // Mirror the portal user so membership FKs exist (User.id = JWT sub;
    // bgc-api cannot read the portal DB, so Stripe customer data fills it).
    if (sub.portalUserId) {
      await this.prisma.user.upsert({
        where: { id: sub.portalUserId },
        create: { id: sub.portalUserId, email, name: customer.name || email, role: 'CLIENT_ADMIN' },
        update: {},
      });
      await this.prisma.clientUser.upsert({
        where: { clientId_userId: { clientId: client.id, userId: sub.portalUserId } },
        create: { clientId: client.id, userId: sub.portalUserId, isPrimaryContact: true },
        update: {},
      });
    }

    try {
      await this.erp.createCompany(companyName, abbr);
      await this.prisma.provisioningJob.update({ where: { id: job.id }, data: { state: 'company_created' } });

      await this.prisma.client.update({ where: { id: client.id }, data: { bookkeepingEnabled: true } });
      await this.prisma.provisioningJob.update({ where: { id: job.id }, data: { state: 'done' } });

      this.logger.log(
        'Provisioned ERPNext Company "' + companyName + '" (' + abbr + ') for client ' + client.slug + ' (job ' + job.id + ')',
      );
      return client.id;
    } catch (err) {
      await this.prisma.provisioningJob
        .update({ where: { id: job.id }, data: { state: 'failed', error: String(err).slice(0, 500) } })
        .catch(() => undefined);
      // Nothing posted yet — best-effort cleanup so a Stripe retry starts fresh.
      await this.erp.deleteCompany(companyName);
      throw err;
    }
  }

  /**
   * Flips bookkeeping on/off for an ALREADY provisioned tenant:
   * resubscribe → enabled, canceled → offboard (cancel-and-retain).
   * DB flags are authoritative; the ERPNext-side Company disable is
   * best-effort (TenantGuard is the primary enforcement anyway).
   */
  async setBookkeepingEnabled(clientId: string, enabled: boolean): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return;

    await this.prisma.client.update({
      where: { id: clientId },
      data: { bookkeepingEnabled: enabled, status: enabled ? 'active' : 'cancelled' },
    });

    if (client.erpCompanyName) {
      await this.erp.setCompanyDisabled(client.erpCompanyName, !enabled).catch((err) =>
        this.logger.warn(
          'Could not ' + (enabled ? 're-enable' : 'disable') + ' ERPNext Company "' + client.erpCompanyName + '": ' + String(err),
        ),
      );
    }
    this.logger.log(
      'Client ' + client.slug + ': bookkeeping ' + (enabled ? 'enabled' : 'disabled (offboard: cancel-and-retain)'),
    );
  }
}
