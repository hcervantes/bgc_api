import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { ErpNextClientService } from './erpnext-client.service';

@Controller('clients/:clientId/erpnext-link')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ErpNextLinkController {
  constructor(private erp: ErpNextClientService) {}

  @Get('health')
  health(@Req() req: Request) {
    // TenantGuard resolved the slug → uuid; service receives the DB id.
    return this.erp.healthCheck(req.tenant!.clientId);
  }
}
