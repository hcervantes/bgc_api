import { Module } from '@nestjs/common';
import { ErpNextLinkController } from './erpnext-link.controller';
import { ErpNextClientService } from './erpnext-client.service';

@Module({
  controllers: [ErpNextLinkController],
  providers: [ErpNextClientService],
  exports: [ErpNextClientService],
})
export class ErpNextModule {}
