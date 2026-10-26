import { Module } from '@nestjs/common';
import { ErpNextLinkController } from './erpnext-link.controller';
import { ErpNextClientService } from './erpnext-client.service';
import { ErpPlatformService } from './erpnext-platform.service';
import { ErpProvisioningService } from './provisioning.service';

@Module({
  controllers: [ErpNextLinkController],
  providers: [ErpNextClientService, ErpPlatformService, ErpProvisioningService],
  exports: [ErpNextClientService, ErpPlatformService, ErpProvisioningService],
})
export class ErpNextModule {}
