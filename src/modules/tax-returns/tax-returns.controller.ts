import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { TaxReturnsService } from './tax-returns.service';
import { PresignUploadDto } from './dto/presign-upload.dto';

@Controller('clients/:clientId/tax-returns')
@UseGuards(JwtAuthGuard, TenantGuard)
export class TaxReturnsController {
  constructor(private service: TaxReturnsService) {}

  @Post('presign-upload')
  @Roles('STAFF', 'ADMIN')
  presign(
    @Req() req: Request,
    @Body() body: PresignUploadDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.presignUpload({
      tenant: req.tenant!,
      taxYear: body.taxYear,
      type: body.type,
      originalFilename: body.originalFilename,
      preparedByUserId: user.sub,
    });
  }

  @Post(':id/finalize')
  @Roles('STAFF', 'ADMIN')
  finalize(@Req() req: Request, @Param('id') id: string) {
    return this.service.finalize(req.tenant!, id);
  }

  @Get()
  list(@Req() req: Request, @Query('taxYear') taxYear?: string) {
    return this.service.list(req.tenant!, taxYear ? Number(taxYear) : undefined);
  }

  @Get(':id/download')
  download(
    @Req() req: Request,
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.download(req.tenant!, id, user.sub, req.ip ?? null);
  }
}
