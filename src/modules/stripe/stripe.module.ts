import { Module } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { BillingStatusController } from './billing-status.controller';
import { StripeWebhookService } from './stripe-webhook.service';

// PrismaModule is @Global() — PrismaService injects without importing it.
@Module({
  controllers: [StripeWebhookController, BillingStatusController],
  providers: [StripeWebhookService],
})
export class StripeModule {}
