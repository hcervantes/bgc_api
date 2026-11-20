import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { MailEvent } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class MailWebhookService {
  private readonly logger = new Logger(MailWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Constant-time Bearer token comparison — Hostinger Mail webhooks send
   *  "Authorization: Bearer <secret>" (per the official OpenAPI spec and a
   *  live delivery, Nov 2026); there is no HMAC signature header. */
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
   *  Returns the created row, or null when it was a duplicate (the caller
   *  uses that to skip reprocessing).
   *  Envelope mapping VERIFIED against a live Hostinger delivery (Nov 2026):
   *  { id, event: "message.received", timestamp,
   *    data: { from: "Name <addr>", mailboxAddress, messageId,
   *            subject, plainBody, htmlBody, bodyUrl,
   *            attachments: [{ fileUrl, filename, sizeBytes, contentType }] } } */
  async recordEvent(payload: any): Promise<MailEvent | null> {
    const eventId = payload?.id ?? payload?.data?.eventId ?? payload?.eventId;
    const eventType = payload?.event ?? payload?.type ?? payload?.eventType ?? 'unknown';
    const mailbox = payload?.data?.mailboxAddress ?? payload?.mailbox ?? null;
    const messageId = payload?.data?.messageId ?? payload?.messageId ?? null;

    if (!eventId || typeof eventId !== 'string') {
      throw new Error('WEBHOOK_MISSING_EVENT_ID');
    }

    // Idempotency probe first; P2002 covers the concurrent race.
    const existing = await this.prisma.mailEvent.findUnique({
      where: { eventId },
    });
    if (existing) {
      this.logger.log('Duplicate mail webhook ' + eventId + ' ignored');
      return null;
    }

    try {
      const created = await this.prisma.mailEvent.create({
        data: {
          eventId,
          eventType,
          mailbox,
          messageId,
          rawPayload: payload,
          status: 'PENDING',
        },
      });
      this.logger.log('MailEvent recorded: ' + eventType + ' (' + eventId + ')');
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        this.logger.log('Duplicate mail webhook ' + eventId + ' (race) ignored');
        return null;
      }
      throw err;
    }
  }
}
