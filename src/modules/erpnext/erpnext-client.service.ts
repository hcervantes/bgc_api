import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decryptSecret } from './credentials.crypto';

export interface ErpHealthResult {
  ok: boolean;
  siteUrl: string;
  checkedAt: string;
  error?: string;
}

/**
 * Thin ERPNext REST client. All calls resolve the client's ErpNextSite row,
 * unseal credentials, and hit the site's /api endpoints with key:secret auth.
 */
@Injectable()
export class ErpNextClientService {
  constructor(private prisma: PrismaService) {}

  /** Resolves the site by CLIENT UUID (req.tenant.clientId). */
  private async siteFor(clientId: string) {
    const site = await this.prisma.erpNextSite.findUnique({ where: { clientId } });
    if (!site || site.status !== 'active') {
      throw new NotFoundException('ERPNEXT_NOT_CONFIGURED');
    }
    return {
      site,
      apiKey: decryptSecret(site.apiKeyEncrypted),
      apiSecret: decryptSecret(site.apiSecretEncrypted),
    };
  }

  /** GET {siteUrl}/api/method/ping with API-key auth; records result on the row. */
  async healthCheck(clientId: string): Promise<ErpHealthResult> {
    const { site, apiKey, apiSecret } = await this.siteFor(clientId);
    const checkedAt = new Date();
    try {
      const res = await fetch(`${site.siteUrl.replace(/\/$/, '')}/api/method/ping`, {
        headers: { Authorization: `token ${apiKey}:${apiSecret}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`ERPNext responded ${res.status}`);
      await this.prisma.erpNextSite.update({
        where: { clientId },
        data: { lastHealthAt: checkedAt, lastHealthOk: true, healthError: null },
      });
      return { ok: true, siteUrl: site.siteUrl, checkedAt: checkedAt.toISOString() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.erpNextSite.update({
        where: { clientId },
        data: { lastHealthAt: checkedAt, lastHealthOk: false, healthError: msg },
      });
      throw new ServiceUnavailableException({ message: 'ERPNEXT_UNREACHABLE', error: msg });
    }
  }
}
