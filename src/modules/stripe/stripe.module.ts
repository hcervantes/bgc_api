import { Module } from '@nestjs/common';
import { ErpNextModule } from '../erpnext/erpnext.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { BillingStatusController } from './billing-status.controller';
import { StripeWebhookService } from './stripe-webhook.service';

// PrismaModule is @Global() — PrismaService injects without importing it.
// ErpNextModule provides ErpProvisioningService (phase 2 hook).
@Module({
  imports: [ErpNextModule],
  controllers: [StripeWebhookController, BillingStatusController],
  providers: [StripeWebhookService],
})
export class StripeModule {}
