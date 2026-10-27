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

  /** Custom Field Journal Entry.stripe_invoice_id — dedupe key for mirrored charges. */
  async ensureJournalEntryCustomField(): Promise<void> {
    const docname = 'Journal Entry-stripe_invoice_id';
    try {
      await this.request('GET', '/api/resource/Custom Field/' + encodeURIComponent(docname));
      return;
    } catch {
      /* not created yet */
    }
    await this.request('POST', '/api/resource/Custom Field', {
      dt: 'Journal Entry',
      fieldname: 'stripe_invoice_id',
      label: 'Stripe Invoice ID',
      fieldtype: 'Data',
      insert_after: 'voucher_type',
      read_only: 1,
    });
    this.logger.log('Created Custom Field Journal Entry.stripe_invoice_id');
  }


  /** Fetch a single doc by doctype/name — null if it does not exist.
   *  Frappe REST gotcha: single-doc GETs wrap the doc in {"data": {...}}
   *  like list GETs do — unwrap or every field read comes back undefined. */
  async getResource<T = Record<string, unknown>>(doctype: string, name: string): Promise<T | null> {
    try {
      const res = (await this.request('GET', '/api/resource/' + encodeURIComponent(doctype) + '/' + encodeURIComponent(name))) as
        | { data?: T }
        | T;
      if (res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)) {
        return (res as { data?: T }).data ?? null;
      }
      return (res as T) ?? null;
    } catch {
      return null;
    }
  }

  /** Generic list query (tenant books, custom-field lookups, etc.). */
  async listResource<T = Record<string, unknown>>(opts: {
    doctype: string;
    filters: unknown[];
    fields: string[];
    orderBy?: string;
    limit?: number;
  }): Promise<T[]> {
    const q =
      '/api/resource/' +
      encodeURIComponent(opts.doctype) +
      '?filters=' +
      encodeURIComponent(JSON.stringify(opts.filters)) +
      '&fields=' +
      encodeURIComponent(JSON.stringify(opts.fields)) +
      (opts.orderBy ? '&order_by=' + encodeURIComponent(opts.orderBy) : '') +
      '&limit_page_length=' +
      (opts.limit ?? 0);
    const res = (await this.request('GET', q)) as { data?: T[] };
    return res?.data ?? [];
  }

  /** Idempotent Custom Field creation (data-plane-wide). */
  async ensureCustomField(spec: {
    docname: string; // e.g. "Journal Entry-portal_entry"
    dt: string;
    fieldname: string;
    label: string;
    fieldtype: string;
    insertAfter: string;
  }): Promise<void> {
    const existing = await this.getResource('Custom Field', spec.docname);
    if (existing) return;
    await this.request('POST', '/api/resource/Custom Field', {
      dt: spec.dt,
      fieldname: spec.fieldname,
      label: spec.label,
      fieldtype: spec.fieldtype,
      insert_after: spec.insertAfter,
      read_only: 1,
    });
    this.logger.log('Created Custom Field ' + spec.docname);
  }

  async findJournalEntryByStripeId(
    stripeInvoiceId: string,
  ): Promise<{ name: string; docstatus: number } | null> {
    const filters = JSON.stringify([['Journal Entry', 'stripe_invoice_id', '=', stripeInvoiceId]]);
    const fields = JSON.stringify(['name', 'docstatus']);
    const res = (await this.request(
      'GET',
      '/api/resource/Journal Entry?filters=' +
        encodeURIComponent(filters) +
        '&fields=' +
        encodeURIComponent(fields) +
        '&limit_page_length=1',
    )) as { data?: Array<{ name?: string; docstatus?: number }> };
    const row = res?.data?.[0];
    if (!row?.name) return null;
    // docstatus comes back 0 (draft) / 1 (submitted); default to 0 if absent.
    return { name: row.name, docstatus: row.docstatus ?? 0 };
  }

  /**
   * BGC subscription fee = EXPENSE in the client's books: "Bookkeeping
   * Fees" (leaf) under Indirect Expenses. Returns the full account docname,
   * e.g. "Bookkeeping Fees - NC". The abbr matches the one sent at Company
   * creation (same initials algorithm — deterministic).
   */
  async ensureExpenseAccount(companyName: string, abbr: string): Promise<string> {
    const accountName = 'Bookkeeping Fees - ' + abbr;
    try {
      await this.request('GET', '/api/resource/Account/' + encodeURIComponent(accountName));
      return accountName;
    } catch {
      /* create below */
    }
    await this.request('POST', '/api/resource/Account', {
      account_name: 'Bookkeeping Fees',
      company: companyName,
      parent_account: 'Indirect Expenses - ' + abbr,
      account_type: 'Expense Account',
      is_group: 0,
    });
    this.logger.log('Created ERPNext Account "' + accountName + '"');
    return accountName;
  }

  async createJournalEntry(payload: Record<string, unknown>): Promise<string> {
    const res = (await this.request('POST', '/api/resource/Journal Entry', payload)) as {
      name?: string;
      data?: { name?: string };
    };
    const name = res?.name ?? res?.data?.name;
    if (!name) throw new Error('Journal Entry created but response carried no name: ' + JSON.stringify(res));
    return name;
  }

  async submitJournalEntry(jeName: string): Promise<void> {
    await this.request('PUT', '/api/resource/Journal Entry/' + encodeURIComponent(jeName), {
      docstatus: 1,
    });
    this.logger.log('Submitted Journal Entry ' + jeName);
  }
}
