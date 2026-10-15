import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContext } from '../../common/auth/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TaxReturnsService {
  constructor(private prisma: PrismaService) {}

  async presignUpload(input: {
    tenant: TenantContext;
    taxYear: number;
    type: string;
    originalFilename: string;
    preparedByUserId: string;
  }) {
    const storageKey = [
      input.tenant.slug,
      'returns',
      input.taxYear,
      `${crypto.randomUUID()}-${input.originalFilename.replace(/[^\w.\-]/g, '_')}`,
    ].join('/');

    const record = await this.prisma.taxReturn.create({
      data: {
        clientId: input.tenant.clientId,
        taxYear: input.taxYear,
        type: input.type as never,
        storageKey,
        originalFilename: input.originalFilename,
        preparedByUserId: input.preparedByUserId,
      },
    });

    // TODO(next phase): pre-signed PUT via @aws-sdk/s3-request-presigner.
    return { id: record.id, storageKey, uploadUrl: null as string | null };
  }

  async finalize(tenant: TenantContext, id: string) {
    const updated = await this.prisma.taxReturn.updateMany({
      where: { id, clientId: tenant.clientId, finalizedAt: null },
      data: { finalizedAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException();
    return { id, finalized: true };
  }

  async list(tenant: TenantContext, taxYear?: number) {
    return this.prisma.taxReturn.findMany({
      where: { clientId: tenant.clientId, ...(taxYear ? { taxYear } : {}) },
      orderBy: [{ taxYear: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async download(tenant: TenantContext, id: string, userId: string, ip: string | null) {
    const record = await this.prisma.taxReturn.findFirst({
      where: { id, clientId: tenant.clientId },
    });
    if (!record) throw new NotFoundException();

    await this.prisma.auditLog.create({
      data: { userId, clientId: tenant.clientId, action: 'tax_return.download', targetId: id, ip },
    });

    // TODO(next phase): pre-signed GET URL (15-min TTL) for storageKey.
    return { id, storageKey: record.storageKey, downloadUrl: null as string | null };
  }
}
