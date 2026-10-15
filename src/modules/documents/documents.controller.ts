import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { PresignUploadDto } from './presign-upload.dto';
import { DocumentsService } from './documents.service';

@Controller('clients/:clientId/documents')
@UseGuards(JwtAuthGuard, TenantGuard)
export class DocumentsController {
  constructor(private service: DocumentsService) {}

  @Post('presign-upload')
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
      uploadedByUserId: user.sub,
    });
  }
}
