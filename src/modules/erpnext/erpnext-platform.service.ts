import { Injectable, Logger } from '@nestjs/common';

/**
 * Platform-level ERPNext REST access (Phase 2).
 *
 * Unlike ErpNextClientService (per-client ErpNextSite credentials), this
 * service uses a single PLATFORM connection from env — the spike proved
 * Company-per-client tenancy on ONE shared site: creating the Company
 * auto-creates the standard Chart of Accounts (97 accounts, each suffixed
 * " - <ABBR>") in seconds.
 *
 * Env (runtime):
 *   ERPNEXT_SITE_URL     e.g. http://bgc-dev.localhost
 *   ERPNEXT_API_KEY      service account api_key
 *   ERPNEXT_API_SECRET   service account api_secret
 *
 * Service-account roles (spike matrix): Accounts Manager + Sales Manager +
 * Sales Master Manager (add the Purchase twins when purchase flows arrive).
 * Token header: Authorization: token <key>:<secret>.
 */
@Injectable()
export class ErpPlatformService {
  private readonly logger = new Logger(ErpPlatformService.name);

  private creds(): { siteUrl: string; auth: string } {
    const siteUrl = process.env.ERPNEXT_SITE_URL?.replace(/\/$/, '');
    const apiKey = process.env.ERPNEXT_API_KEY;
    const apiSecret = process.env.ERPNEXT_API_SECRET;
    if (!siteUrl || !apiKey || !apiSecret) {
      throw new Error(
        'ERPNEXT_SITE_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET are not set — ERPNext provisioning is not configured',
      );
    }
    return { siteUrl, auth: 'token ' + apiKey + ':' + apiSecret };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { siteUrl, auth } = this.creds();
    const res = await fetch(siteUrl + path, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('ERPNext ' + method + ' ' + path + ' → ' + res.status + ': ' + text.slice(0, 300));
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async companyExists(companyName: string): Promise<boolean> {
    // REST gotcha: percent-encode docnames — a raw space silently returns
    // an empty response (spike finding).
    try {
      await this.request('GET', '/api/resource/Company/' + encodeURIComponent(companyName));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates the Company — ERPNext auto-creates the standard CoA with
   * " - <ABBR>" suffixes (spike-verified: single insert, seconds).
   * Idempotent: an existing Company (retry after partial failure) is a no-op.
   */
  async createCompany(companyName: string, abbr: string): Promise<void> {
    if (await this.companyExists(companyName)) {
      this.logger.log('Company "' + companyName + '" already exists — skipping create (idempotent retry)');
      return;
    }
    await this.request('POST', '/api/resource/Company', {
      company: companyName,
      abbr,
      country: 'United States',
      chart_of_accounts: 'Standard',
      company_type: 'Company',
    });
  }

  async setCompanyDisabled(companyName: string, disabled: boolean): Promise<void> {
    await this.request('PUT', '/api/resource/Company/' + encodeURIComponent(companyName), {
      disabled: disabled ? 1 : 0,
    });
  }

  /**
   * Cleanup for FAILED provisioning only (nothing posted yet). Submitted
   * financial docs are cancel-and-retain, never deletable (spike finding) —
   * offboarding uses setCompanyDisabled instead.
   */
  async deleteCompany(companyName: string): Promise<void> {
    try {
      await this.request('DELETE', '/api/resource/Company/' + encodeURIComponent(companyName));
    } catch (err) {
      this.logger.warn('Company cleanup for "' + companyName + '" failed: ' + String(err));
    }
  }
}
