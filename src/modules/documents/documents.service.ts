import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../common/auth/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Records a pending_upload Document row and returns a pre-signed PUT URL
   * for direct-to-Spaces upload. Storage wiring (S3 client) is the next
   * phase — for now the record is created and the presign step is stubbed.
   */
  async presignUpload(input: {
    tenant: TenantContext;
    taxYear: number;
    type: string;
    originalFilename: string;
    uploadedByUserId: string;
  }) {
    const storageKey = [
      input.tenant.slug,
      'uploads',
      input.taxYear,
      `${crypto.randomUUID()}-${input.originalFilename.replace(/[^\w.\-]/g, '_')}`,
    ].join('/');

    const doc = await this.prisma.document.create({
      data: {
        clientId: input.tenant.clientId,
        uploadedByUserId: input.uploadedByUserId,
        taxYear: input.taxYear,
        type: input.type as never,
        storageKey,
        originalFilename: input.originalFilename,
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        status: 'pending_upload',
      },
    });

    // TODO(next phase): @aws-sdk/s3-request-presigner getSignedUrl(PutObject)
    return { documentId: doc.id, storageKey, uploadUrl: null as string | null };
  }
}
