import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { ClientsService } from './clients.service';

@Controller('clients/:clientId')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ClientsController {
  constructor(private service: ClientsService) {}

  /** Basic client info — any authenticated tenant member. */
  @Get()
  get(@Req() req: Request) {
    return this.service.get(req.tenant!);
  }
}
