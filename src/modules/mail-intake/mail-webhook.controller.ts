import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { MailWebhookService } from './mail-webhook.service';
import { MAIL_WEBHOOK_SIGNATURE_HEADER } from './mail-webhook.constants';

// Webhook envelopes are small; attachments are fetched by the worker via
// the Mail API, never through the webhook body.
const MAX_BODY_BYTES = 64 * 1024;

// @Public() + Bearer/HMAC auth only — like the Stripe webhook, JWT guards do
// not apply. (Guard is per-controller in bgc_api; this controller deliberately
// does NOT add @UseGuards(JwtAuthGuard).)
//
// VERIFIED against real Hostinger deliveries (Nov 2026): Hostinger Mail
// webhooks authenticate with "Authorization: Bearer <token>" (plus
// x-correlation-id), NOT an HMAC signature header. HMAC support is kept as a
// fallback so the receiver still works if Hostinger adds signed delivery.
@Controller('webhooks/mail')
export class MailWebhookController {
  private readonly logger = new Logger(MailWebhookController.name);

  constructor(private readonly mailWebhookService: MailWebhookService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization?: string,
    @Headers(MAIL_WEBHOOK_SIGNATURE_HEADER) signature?: string,
  ) {
    const rawBody = req.rawBody;

    if (!rawBody || !rawBody.length) {
      // rawBody: true is set in main.ts (Stripe requirement) — required here too.
      throw new BadRequestException('MISSING_RAW_BODY');
    }
    if (rawBody.length > MAX_BODY_BYTES) {
      throw new BadRequestException('PAYLOAD_TOO_LARGE');
    }

    // 1. Authenticate BEFORE any JSON parsing. Bearer token (Hostinger's
    //    actual scheme) or, if present, HMAC signature over the raw body.
    const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const authed =
      (bearerMatch && (await this.mailWebhookService.verifyBearerToken(bearerMatch))) ||
      (signature && (await this.mailWebhookService.verifySignature(rawBody, signature)));
    if (!authed) {
      this.logger.warn('Mail webhook auth failed (no valid bearer token or signature)');
      throw new UnauthorizedException('INVALID_SIGNATURE');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('INVALID_JSON');
    }

    // 2. Insert-first dedupe keyed on eventId (unique). recordEvent throws
    //    on missing id → 500 → Hostinger retries. Handler failures in later
    //    PRs delete the row so retries reprocess (Stripe pattern).
    await this.mailWebhookService.recordEvent(parsed);
    return { received: true };
  }
}
