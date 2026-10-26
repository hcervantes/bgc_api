import { Module } from '@nestjs/common';
import { ErpNextLinkController } from './erpnext-link.controller';
import { ErpNextClientService } from './erpnext-client.service';
import { ErpPlatformService } from './erpnext-platform.service';
import { ErpProvisioningService } from './provisioning.service';
import { ErpInvoiceSyncService } from './invoice-sync.service';

@Module({
  controllers: [ErpNextLinkController],
  providers: [ErpNextClientService, ErpPlatformService, ErpProvisioningService, ErpInvoiceSyncService],
  exports: [ErpNextClientService, ErpPlatformService, ErpProvisioningService, ErpInvoiceSyncService],
})
export class ErpNextModule {}
