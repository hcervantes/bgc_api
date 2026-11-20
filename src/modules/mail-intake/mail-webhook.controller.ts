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

// @Public() + HMAC only — like the Stripe webhook, JWT guards do not apply.
// (Guard is per-controller in bgc_api; this controller deliberately does NOT
// add @UseGuards(JwtAuthGuard).)
@Controller('webhooks/mail')
export class MailWebhookController {
  private readonly logger = new Logger(MailWebhookController.name);

  constructor(private readonly mailWebhookService: MailWebhookService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
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
    if (!signature) {
      throw new UnauthorizedException('MISSING_SIGNATURE');
    }

    // 1. Verify HMAC on the RAW body BEFORE any JSON parsing — a
    //    re-serialized parsed body produces a different signature.
    const valid = await this.mailWebhookService.verifySignature(rawBody, signature);
    if (!valid) {
      this.logger.warn('Invalid mail webhook signature');
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
