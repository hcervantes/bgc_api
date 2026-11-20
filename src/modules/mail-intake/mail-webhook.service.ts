import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class MailWebhookService {
  private readonly logger = new Logger(MailWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Constant-time Bearer token comparison — Hostinger Mail webhooks send
   *  "Authorization: Bearer <token>" (verified Nov 2026); there is no HMAC
   *  signature header in their current scheme. */
  async verifyBearerToken(provided: string): Promise<boolean> {
    const expected = this.config.get<string>('HOSTINGER_WEBHOOK_TOKEN');
    if (!expected) {
      // Fail-closed everywhere, dev included.
      this.logger.error('HOSTINGER_WEBHOOK_TOKEN not configured');
      return false;
    }
    const a = Buffer.from(provided.trim());
    const b = Buffer.from(expected.trim());
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Constant-time HMAC-SHA256 comparison over the RAW request body.
   *  Kept as a fallback in case Hostinger adds signed delivery later. */
  async verifySignature(rawBody: Buffer, signature: string): Promise<boolean> {
    const secret = this.config.get<string>('HOSTINGER_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn('HOSTINGER_WEBHOOK_SECRET not configured (HMAC path disabled)');
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
    } catch {
      return false;
    }
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  /** Insert-first dedupe on unique eventId — same pattern as StripeEvent.
   *  Field names are read tolerantly (id/eventId, type/eventType) until
   *  verified against a real Hostinger delivery. */
  async recordEvent(payload: any): Promise<void> {
    const eventId = payload?.id ?? payload?.eventId ?? payload?.data?.id;
    const eventType = payload?.type ?? payload?.eventType ?? 'unknown';
    const mailbox = payload?.mailbox ?? payload?.data?.mailbox ?? null;
    const messageId = payload?.messageId ?? payload?.data?.messageId ?? null;

    if (!eventId || typeof eventId !== 'string') {
      throw new Error('WEBHOOK_MISSING_EVENT_ID');
    }

    // Idempotency probe first; P2002 covers the concurrent race.
    const existing = await this.prisma.mailEvent.findUnique({
      where: { eventId },
    });
    if (existing) {
      this.logger.log(`Duplicate mail webhook ${eventId} ignored`);
      return;
    }

    try {
      await this.prisma.mailEvent.create({
        data: {
          eventId,
          eventType,
          mailbox,
          messageId,
          rawPayload: payload,
          status: 'PENDING',
        },
      });
      this.logger.log(`MailEvent recorded: ${eventType} (${eventId})`);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        this.logger.log(`Duplicate mail webhook ${eventId} (race) ignored`);
        return;
      }
      throw err;
    }
  }
}
