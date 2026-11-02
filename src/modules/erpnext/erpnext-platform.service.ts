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
 *   MILEAGE_RATE_CENTS   IRS standard mileage rate in cents/mile (BooksService)
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

  /** Memo for ensureVehicleDoctypes — reset on failure so a transient
   *  ERPNext outage never poisons the process with a cached rejection. */
  private vehicleDoctypesEnsure: Promise<void> | null = null;

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

  /** Create an Account — returns its docname ("Name - ABBR"). */
  async createAccount(payload: Record<string, unknown>): Promise<string> {
    const res = (await this.request('POST', '/api/resource/Account', payload)) as {
      name?: string;
      data?: { name?: string };
    };
    const name = res?.name ?? res?.data?.name;
    if (!name) throw new Error('Account created but response carried no name: ' + JSON.stringify(res));
    return name;
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

  /** Generic doc create — returns the new docname (unwraps {data} like
   *  getResource; Frappe wraps POST responses the same way). */
  async createResource(doctype: string, payload: Record<string, unknown>): Promise<string> {
    const res = (await this.request('POST', '/api/resource/' + encodeURIComponent(doctype), payload)) as {
      name?: string;
      data?: { name?: string };
    };
    const name = res?.name ?? res?.data?.name;
    if (!name) throw new Error(doctype + ' created but response carried no name: ' + JSON.stringify(res));
    return name;
  }

  /** Generic doc update (e.g. linking an Odometer Log back to its JE). */
  async updateResource(doctype: string, name: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(
      'PUT',
      '/api/resource/' + encodeURIComponent(doctype) + '/' + encodeURIComponent(name),
      payload,
    );
  }

  /**
   * POST /api/method/<method> with a JSON body — call a whitelisted server
   * method. NOTE (bgc-dev, Nov 2): frappe.permissions.add_permission is NOT
   * whitelisted in v16 (403 "Function ... is not whitelisted") — retained
   * for methods that are.
   */
  async callMethod(method: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = (await this.request('POST', '/api/method/' + method, body ?? {})) as { message?: unknown };
    return res?.message ?? res;
  }

  /** Idempotent Custom Field creation (data-plane-wide). */
  async ensureCustomField(spec: {
    docname: string; // e.g. "Journal Entry-portal_entry"
    dt: string;
    fieldname: string;
    label: string;
    fieldtype: string;
    insertAfter: string;
    /** For Link fields only: the target DocType, e.g. "Company". */
    options?: string;
  }): Promise<void> {
    const existing = await this.getResource('Custom Field', spec.docname);
    if (existing) return;
    const payload: Record<string, unknown> = {
      dt: spec.dt,
      fieldname: spec.fieldname,
      label: spec.label,
      fieldtype: spec.fieldtype,
      insert_after: spec.insertAfter,
      read_only: 1,
    };
    if (spec.options) payload.options = spec.options;
    await this.request('POST', '/api/resource/Custom Field', payload);
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

  /**
   * Phase 4.2 — the tenant's mileage expense account. Created under
   * Indirect Expenses (same parent as Bookkeeping Fees, which is known to
   * exist on the standard chart); staff can move it later if they prefer
   * Direct Expenses.
   */
  async ensureMileageAccount(companyName: string, abbr: string): Promise<string> {
    const accountName = 'Vehicle Expenses - ' + abbr;
    try {
      await this.request('GET', '/api/resource/Account/' + encodeURIComponent(accountName));
      return accountName;
    } catch {
      /* create below */
    }
    await this.request('POST', '/api/resource/Account', {
      account_name: 'Vehicle Expenses',
      company: companyName,
      parent_account: 'Indirect Expenses - ' + abbr,
      account_type: 'Expense Account',
      is_group: 0,
    });
    this.logger.log('Created ERPNext Account "' + accountName + '"');
    return accountName;
  }

  /**
   * Phase 4.2 — vehicle tracking setup. MEMOIZED per process (reset on
   * failure): every books read path calls this before its first query,
   * so the roundtrips must not repeat on every request.
   *
   * DECIDED (Oct 30, 2026): odometer replaces manual miles; users log
   * readings, the system computes miles from the previous reading.
   * Frappe HR's Vehicle Log was considered and DECLINED (HR app, Employee
   * + Expense Claim machinery, wrong tenancy fit).
   *
   * IMPORTANT (bgc-dev finding, Nov 2 2026): ERPNext v16 ships a NATIVE
   * "Vehicle" DocType (module Setup, custom=0 — used by e-Way Bill
   * transport; the earlier assumption that it "moved into Frappe HR at
   * v14" is wrong, and hrms is not installed here anyway). NEVER create
   * or drop it. We ride on the native doctype: tenancy uses its native
   * company field, the current reading uses its native last_odometer
   * field, and the portal-facing label rides on the portal_vehicle_name
   * Custom Field created below. Docnames are one global namespace
   * (license_plate, with a UNIQUE key), so BooksService namespaces
   * cross-tenant label collisions with the Company abbr — the same
   * pattern as Customer.
   *
   * "Odometer Log" IS ours (custom DocType, module Core) and is created
   * here. FRAPPE GOTCHAS (bgc-dev, Nov 2 — FOUR layers, all fixed here):
   *  1. A DocType created via REST with NO permissions array gets ZERO
   *     role permissions — even System Manager 403s. The create payload
   *     ships a System Manager DocPerm row; the self-heal below patches
   *     doctypes created by the earlier payload.
   *  2. The NATIVE Vehicle doctype ALSO ships with an empty permission
   *     table (rarely-used e-Way Bill doctype) → 403 for everyone.
   *  3. Standard DocTypes can't be PUT-ed via REST outside developer
   *     mode (417 CannotCreateStandardDoctypeError) — the DocType PUT
   *     trick only works for CUSTOM doctypes.
   *  4. frappe.permissions.add_permission is NOT whitelisted (403 via
   *     /api/method). The REST-legal route is the "Custom DocPerm"
   *     doctype — Frappe's own mechanism for layering extra permissions
   *     onto standard doctypes without developer mode. ensureNativeVehicle
   *     Permission probes first, creates the Custom DocPerm if missing,
   *     re-probes, and fails with the bench-console one-liner if the
   *     site still refuses.
   */
  async ensureVehicleDoctypes(): Promise<void> {
    this.vehicleDoctypesEnsure ??= this.doEnsureVehicleDoctypes().catch((err) => {
      // Don't cache a rejection: ERPNext being briefly down at first
      // call must not 500 every books request for the process lifetime.
      this.vehicleDoctypesEnsure = null;
      throw err;
    });
    return this.vehicleDoctypesEnsure;
  }

  /** Probe: can the service account list Vehicle docs? (403 → false). */
  private async canReadVehicles(): Promise<boolean> {
    try {
      await this.listResource({ doctype: 'Vehicle', filters: [['Vehicle', 'name', 'is', 'set']], fields: ['name'], limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Grant System Manager access to the NATIVE Vehicle doctype. It ships
   * with an empty permission table, and every direct route to its DocPerm
   * child table is blocked for the REST user (no developer mode; the
   * permission method not whitelisted) — so the grant rides on a
   * "Custom DocPerm" row, which Frappe merges into the doctype's runtime
   * permissions. Probes before/after; if the site still refuses, throws
   * with the bench-console fix so ops isn't left guessing.
   */
  private async ensureNativeVehiclePermission(): Promise<void> {
    if (await this.canReadVehicles()) return;

    const existing = await this.listResource<{ name: string }>({
      doctype: 'Custom DocPerm',
      filters: [
        ['Custom DocPerm', 'parent', '=', 'Vehicle'],
        ['Custom DocPerm', 'role', '=', 'System Manager'],
        ['Custom DocPerm', 'permlevel', '=', 0],
      ],
      fields: ['name'],
      limit: 1,
    });

    if (existing.length === 0) {
      try {
        await this.createResource('Custom DocPerm', {
          parent: 'Vehicle',
          role: 'System Manager',
          permlevel: 0,
          read: 1,
          write: 1,
          create: 1,
          delete: 1,
          report: 1,
          share: 1,
        });
        this.logger.log('Created Custom DocPerm: System Manager on native "Vehicle" (shipped with no permissions)');
      } catch (err) {
        this.logger.warn('Custom DocPerm create on Vehicle failed: ' + String(err));
      }
    }

    if (!(await this.canReadVehicles())) {
      throw new Error(
        'The native "Vehicle" doctype has no role permissions and they could not be granted over REST. ' +
          'Run once in bench console (docker exec -it erpnext-backend-1 bash, then bench --site <site> console): ' +
          'frappe.permissions.add_permission("Vehicle", "System Manager"); frappe.db.commit()',
      );
    }
  }

  private async doEnsureVehicleDoctypes(): Promise<void> {
    await this.ensureNativeVehiclePermission();

    // Ride on the NATIVE Vehicle doctype — label custom field only.
    await this.ensureCustomField({
      docname: 'Vehicle-portal_vehicle_name',
      dt: 'Vehicle',
      fieldname: 'portal_vehicle_name',
      label: 'Portal Vehicle Name',
      fieldtype: 'Data',
      insertAfter: 'model',
    });

    const ODOMETER_LOG_PERMS = [
      {
        role: 'System Manager',
        read: 1,
        write: 1,
        create: 1,
        delete: 1,
        report: 1,
        share: 1,
      },
    ];

    const dt = await this.getResource<{ permissions?: Array<{ role?: string }> }>('DocType', 'Odometer Log');
    if (!dt) {
      await this.request('POST', '/api/resource/DocType', {
        name: 'Odometer Log',
        module: 'Core',
        custom: 1,
        autoname: 'format:ODO-{#####}',
        naming_rule: 'Expression',
        title_field: 'purpose',
        is_submitable: 0,
        istable: 0,
        track_changes: 1,
        permissions: ODOMETER_LOG_PERMS,
        fields: [
          { fieldname: 'vehicle', fieldtype: 'Link', label: 'Vehicle', reqd: 1, options: 'Vehicle', in_list_view: 1, in_standard_filter: 1 },
          { fieldname: 'vehicle_name', fieldtype: 'Data', label: 'Vehicle Name', read_only: 1, in_list_view: 1 },
          { fieldname: 'date', fieldtype: 'Date', label: 'Date', reqd: 1, in_list_view: 1 },
          { fieldname: 'odometer', fieldtype: 'Int', label: 'Odometer', reqd: 1, in_list_view: 1 },
          { fieldname: 'miles', fieldtype: 'Float', label: 'Miles', read_only: 1, in_list_view: 1 },
          { fieldname: 'rate', fieldtype: 'Currency', label: 'Rate', read_only: 1 },
          { fieldname: 'amount', fieldtype: 'Currency', label: 'Amount', read_only: 1 },
          { fieldname: 'purpose', fieldtype: 'Small Text', label: 'Purpose (business trip)' },
          { fieldname: 'company', fieldtype: 'Link', label: 'Company', reqd: 1, options: 'Company' },
          { fieldname: 'portal_user_id', fieldtype: 'Data', label: 'Portal User', read_only: 1 },
          { fieldname: 'journal_entry', fieldtype: 'Link', label: 'Journal Entry', options: 'Journal Entry', read_only: 1 },
        ],
      });
      this.logger.log('Created custom DocType "Odometer Log"');
      return;
    }

    // Self-heal: doctypes created before the permissions fix (bgc-dev)
    // have no role rows at all → 403 for everyone, System Manager
    // included. Odometer Log is CUSTOM, so a DocType PUT is allowed and
    // the full-permissions array replaces the (empty) child table.
    const hasSysManager = (dt.permissions ?? []).some((p) => p.role === 'System Manager');
    if (!hasSysManager) {
      await this.updateResource('DocType', 'Odometer Log', { permissions: ODOMETER_LOG_PERMS });
      this.logger.log('Patched "Odometer Log" with System Manager permissions (created without any)');
    }
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
