import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { CreateEntryDto } from './create-entry.dto';
import { BooksService } from './books.service';

/** Tenant-scoped bookkeeping entry endpoints (Standard tier self-entry). */
@Controller('clients/:clientId/books')
@UseGuards(JwtAuthGuard, TenantGuard)
export class BooksController {
  constructor(private service: BooksService) {}

  /** Chart-of-accounts options for the entry form dropdowns. */
  @Get('accounts')
  accounts(@Req() req: Request, @Query('type') type: string) {
    return this.service.listAccounts(req.tenant as { clientId: string }, type);
  }

  /** The tenant's own portal-entered entries (most recent 50). */
  @Get('entries')
  entries(@Req() req: Request) {
    return this.service.listEntries(req.tenant as { clientId: string });
  }

  /** Customer-created category (Account in the tenant's chart). */
  @Post('categories')
  createCategory(
    @Req() req: Request,
    @Body() dto: { type: string; label: string },
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.createCategory(req.tenant as { clientId: string }, user.sub, dto);
  }

  @Post('entries')
  create(
    @Req() req: Request,
    @Body() dto: CreateEntryDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.createEntry(req.tenant as { clientId: string }, user.sub, dto);
  }
}
