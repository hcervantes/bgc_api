import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { StripeWebhookService } from './stripe-webhook.service';

// POST /v1/webhooks/stripe  (the global 'v1' prefix applies)
//
// Public: authentication is the Stripe signature itself, verified against
// STRIPE_WEBHOOK_SECRET. Raw body capture is required for the HMAC —
// see the rawBody: true option in main.ts.
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.webhooks.handle(req.rawBody, signature);
  }
}
