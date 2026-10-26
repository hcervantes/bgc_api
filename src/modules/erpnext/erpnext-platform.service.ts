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
 * Falls back to the seeded spike credentials if the primary set is absent:
 *   ERPNEXT_SEED_SITE_URL / ERPNEXT_SEED_API_KEY / ERPNEXT_SEED_API_SECRET
 *
 * Service-account roles (spike matrix): Accounts Manager + Sales Manager +
 * Sales Master Manager (add the Purchase twins when purchase flows arrive).
 * Token header: Authorization: token <key>:<secret>.
 */
@Injectable()
export class ErpPlatformService {
  private readonly logger = new Logger(ErpPlatformService.name);

  private creds(): { siteUrl: string; auth: string } {
    const siteUrl = (process.env.ERPNEXT_SITE_URL ?? process.env.ERPNEXT_SEED_SITE_URL)?.replace(/\/$/, '');
    const apiKey = process.env.ERPNEXT_API_KEY ?? process.env.ERPNEXT_SEED_API_KEY;
    const apiSecret = process.env.ERPNEXT_API_SECRET ?? process.env.ERPNEXT_SEED_API_SECRET;
    if (!siteUrl || !apiKey || !apiSecret) {
      throw new Error(
        'ERPNEXT_SITE_URL/API_KEY/API_SECRET (or the ERPNEXT_SEED_* fallbacks) are not set — ERPNext provisioning is not configured',
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
    // Company doctype: the name field is company_name (docname is
    // derived from it). chart_of_accounts omitted → ERPNext default
    // standard chart (97 accounts, " - <ABBR>" suffixes — spike-verified).
    await this.request('POST', '/api/resource/Company', {
      company_name: companyName,
      abbr,
      country: 'United States',
      default_currency: 'USD',
      company_type: 'Company',
    });
    this.logger.log('Created ERPNext Company "' + companyName + '" (' + abbr + ')');
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

  // ── Invoice sync (phase 2) ──────────────────────────────────────────────

  /** Custom Field Sales Invoice.stripe_invoice_id — dedupe key for mirrored invoices. */
  async ensureSalesInvoiceCustomField(): Promise<void> {
    const docname = 'Sales Invoice-stripe_invoice_id';
    try {
      await this.request('GET', '/api/resource/Custom Field/' + encodeURIComponent(docname));
      return;
    } catch {
      /* not created yet */
    }
    await this.request('POST', '/api/resource/Custom Field', {
      dt: 'Sales Invoice',
      fieldname: 'stripe_invoice_id',
      label: 'Stripe Invoice ID',
      fieldtype: 'Data',
      insert_after: 'customer',
      read_only: 1,
    });
    this.logger.log('Created Custom Field Sales Invoice.stripe_invoice_id');
  }

  async findSalesInvoiceByStripeId(stripeInvoiceId: string): Promise<string | null> {
    const filters = JSON.stringify([['Sales Invoice', 'stripe_invoice_id', '=', stripeInvoiceId]]);
    const fields = JSON.stringify(['name', 'docstatus']);
    const res = (await this.request(
      'GET',
      '/api/resource/Sales Invoice?filters=' +
        encodeURIComponent(filters) +
        '&fields=' +
        encodeURIComponent(fields) +
        '&limit_page_length=1',
    )) as { data?: Array<{ name: string }> };
    return res?.data?.[0]?.name ?? null;
  }

  /** Customer is not company-scoped in ERPNext; keyed by tenant name. */
  async ensureCustomer(name: string): Promise<string> {
    try {
      await this.request('GET', '/api/resource/Customer/' + encodeURIComponent(name));
      return name;
    } catch {
      /* create below */
    }
    await this.request('POST', '/api/resource/Customer', {
      customer_name: name,
      customer_type: 'Individual',
      customer_group: 'Individual',
      territory: 'All Territories',
    });
    this.logger.log('Created ERPNext Customer "' + name + '"');
    return name;
  }

  async ensureItem(itemCode: string, itemName = itemCode): Promise<void> {
    try {
      await this.request('GET', '/api/resource/Item/' + encodeURIComponent(itemCode));
      return;
    } catch {
      /* create below */
    }
    await this.request('POST', '/api/resource/Item', {
      item_code: itemCode,
      item_name: itemName,
      item_group: 'Services',
      stock_item: 0,
    });
    this.logger.log('Created ERPNext Item "' + itemCode + '"');
  }

  async createSalesInvoice(payload: Record<string, unknown>): Promise<string> {
    const res = (await this.request('POST', '/api/resource/Sales Invoice', payload)) as { name: string };
    return res.name;
  }

  async submitSalesInvoice(invoiceName: string): Promise<void> {
    await this.request('PUT', '/api/resource/Sales Invoice/' + encodeURIComponent(invoiceName), {
      docstatus: 1,
    });
    this.logger.log('Submitted Sales Invoice ' + invoiceName);
  }
}
