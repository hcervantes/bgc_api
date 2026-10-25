import { Module } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';

// PrismaModule is @Global() — PrismaService injects without importing it.
@Module({
  controllers: [StripeWebhookController],
  providers: [StripeWebhookService],
})
export class StripeModule {}
