import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../common/auth/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class ClientsService {
  constructor(private prisma: PrismaService) {}

  async get(tenant: TenantContext) {
    const client = await this.prisma.client.findUnique({
      where: { id: tenant.clientId },
      select: {
        slug: true,
        name: true,
        legalName: true,
        email: true,
        status: true,
        bookkeepingEnabled: true,
      },
    });
    return client;
  }
}
