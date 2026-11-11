import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from '../erpnext/erpnext-platform.service';
import { CreateEntryDto, EntryType } from './create-entry.dto';
import { UpdateAssetDto } from './update-asset.dto';
import { CreateOdometerDto } from './odometer.dto';

// Entry type → ERPNext root_type on the tenant's chart.
// root_type is the robust discriminator: EVERY account has one from its
// position in the chart, whereas account_type is only set on special
// accounts (Cash/Bank/etc.) — the standard CoA leaves ordinary expense
// and income accounts untyped, so filtering on account_type yields empty
// category dropdowns.
const ROOT_TYPE_BY_ENTRY: Record<EntryType, string> = {
  expense: 'Expense',
  income: 'Income',
  asset: 'Asset',
};

// Asset categories exclude the company's own liquid/operating accounts —
// "what your business owns" is equipment, vehicles, etc., not its own cash.
// Contra-asset / non-ownership accounts must not appear either: Accumulated
// Depreciation is a CREDIT-balance account — a user picking it for an asset
// purchase (seen on bgc-dev, Nov 2026) debits the wrong account. 'Depreciation'
// (the expense account_type) is excluded for the same reason: it belongs to
// the depreciation workflow, not to what the business owns.
const ASSET_EXCLUDED_TYPES = ['Cash', 'Bank', 'Receivable', 'Payable', 'Stock', 'Accumulated Depreciation', 'Depreciation'];

// Same label guard as categories — customer/vehicle names land in docnames.
const NAME_GUARD = /^[A-Za-z0-9 &'./-]{1,50}$/;

/**
 * Phase 4 — Standard-tier customer self-entry.
 *
 * Security model (the cross-tenant guarantee):
 * - The tenant Company name comes ONLY from the authenticated session's
 *   Client row (TenantGuard) — never from the request body.
 * - accountName / customerName / vehicleName are resolved against ERPNext
 *   and MUST belong to that Company; anything else is 404'd as
 *   anti-enumeration, exactly like TenantGuard does for client slugs.
 * - Every created Journal Entry is tagged (portal_entry, portal_user_id)
 *   and audited in the AuditLog.
 *
 * Phase 4.2 (odometer revision, Oct 30, 2026):
 * - Vehicles: ERPNext's NATIVE "Vehicle" doctype (module Setup — do not
 *   create or drop it), tenant-scoped by its native company field. The
 *   user-facing label rides on the portal_vehicle_name custom field;
 *   last_odometer is the native current-reading field. Docnames are one
 *   global namespace (license_plate), so cross-tenant label collisions
 *   are suffixed with the Company abbr, exactly like Customer.
 * - Odometer readings REPLACE manual miles: miles are computed from the
 *   previous reading per vehicle. First reading = baseline (no JE). A
 *   reading WITH a purpose = business trip → auto-posted JE at the IRS
 *   standard rate (rate snapshotted on the row). Reading without purpose =
 *   plain odometer capture (IRS wants BOY/EOY readings; personal-vs-
 *   business split deferred).
 * - Customers: ERPNext Customer docs scoped to the tenant via the
 *   portal_company custom field (Customer has NO native Company field).
 * - Expense/asset entries may reference a Vehicle (fuel, maintenance,
 *   repairs...) via Journal Entry.portal_vehicle_name.
 */
@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  /** One-shot memo for ensureBooksMeta — reset on failure (see there). */
  private booksMetaEnsure: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpPlatformService,
  ) {}

  /** Same initials algorithm as provisioning/invoice-sync — deterministic.
   *  Accepts the nullable erpCompanyName as declared on the Client model;
   *  loadTenantBook has already rejected a tenant without it. */
  private abbrFor(name: string | null): string {
    const abbr = (name ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 5);
    return abbr || 'BGC';
  }

  /**
   * IRS standard mileage rate in CENTS per mile, from env. The rate is
   * snapshotted onto each Odometer Log row at posting time, so changing
   * the env var never rewrites history. Default 70¢ = the last known IRS
   * business rate — set MILEAGE_RATE_CENTS to the current-year rate.
   */
  private mileageRateCents(): number {
    const v = Number(process.env.MILEAGE_RATE_CENTS ?? '70');
    if (!Number.isFinite(v) || v <= 0) {
      throw new BadRequestException('MILEAGE_RATE_NOT_CONFIGURED');
    }
    return v;
  }

  /** Tenant Client row with bookkeeping live — else anti-enumeration 404.
   *  Separate early throws (not one ||-chain) so TS flow analysis
   *  narrows the return to non-null for callers. */
  private async loadTenantBook(tenant: { clientId: string }): Promise<{ id: string; erpCompanyName: string }> {
    const client = await this.prisma.client.findUnique({ where: { id: tenant.clientId } });
    if (!client) {
      // Not an error state to reveal: same 404 as a non-member tenant.
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    if (!client.bookkeepingEnabled || !client.erpCompanyName) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    // Return the narrowed shape every books method consumes — the guard
    // above proves erpCompanyName is non-null, but returning the raw
    // Prisma row keeps it typed string | null downstream.
    return { id: client.id, erpCompanyName: client.erpCompanyName };
  }

  /**
   * ONE-SHOT per process: every custom field + custom doctype the books
   * READ paths query. FRAPPE GOTCHA (bgc-dev, Nov 2): a list that
   * filters/returns a custom field which does not exist yet 417s with
   * "Field not permitted in query" — the write paths ensured everything
   * lazily, but on a fresh site the very first request is a page-load GET.
   * Memoized so the ensure roundtrips run once per process, not per
   * request; the memo resets on failure so a transient ERPNext outage
   * isn't cached as a permanent rejection.
   */
  private ensureBooksMeta(): Promise<void> {
    this.booksMetaEnsure ??= (async () => {
      await this.erp.ensureVehicleDoctypes();
      await this.erp.ensureCustomField({
        docname: 'Customer-portal_company',
        dt: 'Customer',
        fieldname: 'portal_company',
        label: 'Portal Company',
        fieldtype: 'Link',
        options: 'Company',
        insertAfter: 'customer_group',
      });
      await this.ensurePortalCustomFields();
      await this.ensureCustomerDefaults();
    })().catch((err) => {
      this.booksMetaEnsure = null;
      throw err;
    });
    return this.booksMetaEnsure;
  }

  async listAccounts(tenant: { clientId: string }, type: string): Promise<Array<{ name: string; label: string }>> {
    if (!(type in ROOT_TYPE_BY_ENTRY)) {
      throw new BadRequestException('type must be expense, income, or asset');
    }
    const client = await this.loadTenantBook(tenant);
    const filters: unknown[][] = [
      ['Account', 'company', '=', client.erpCompanyName],
      ['Account', 'root_type', '=', ROOT_TYPE_BY_ENTRY[type as EntryType]],
      ['Account', 'is_group', '=', 0],
    ];
    if (type === 'asset') {
      filters.push(['Account', 'account_type', 'not in', ASSET_EXCLUDED_TYPES]);
    }
    const rows = await this.erp.listResource<{ name: string; account_name: string }>({
      doctype: 'Account',
      filters,
      fields: ['name', 'account_name'],
    });
    return rows.map((a) => ({ name: a.name, label: a.account_name }));
  }

  async createEntry(
    tenant: { clientId: string },
    portalUserId: string,
    dto: CreateEntryDto,
  ): Promise<{ journalEntry: string }> {
    const client = await this.loadTenantBook(tenant);
    const expectedRoot = ROOT_TYPE_BY_ENTRY[dto.type];

    // Cross-tenant guarantee: the account must exist AND belong to the
    // tenant's Company with the expected root_type (and, for assets, not
    // be a liquid/operating account). Foreign account → 404
    // (anti-enumeration), never a write.
    const account = await this.erp.getResource<{
      company?: string;
      root_type?: string;
      account_type?: string;
    }>('Account', dto.accountName);
    if (
      account?.company !== client.erpCompanyName ||
      account?.root_type !== expectedRoot ||
      (dto.type === 'asset' && ASSET_EXCLUDED_TYPES.includes(account.account_type ?? ''))
    ) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    // Phase 4.2 — income entries may reference one of the tenant's own
    // Customers. Foreign customer → 404, exactly like a foreign account.
    if (dto.type === 'income' && dto.customerName) {
      const customer = await this.erp.getResource<{ portal_company?: string }>('Customer', dto.customerName);
      if (customer?.portal_company !== client.erpCompanyName) {
        throw new NotFoundException('CUSTOMER_NOT_FOUND');
      }
    }
    // Phase 4.3 — asset-tab vehicle entry: create-or-reuse the Vehicle by
    // its plain label so a vehicle is BOTH a fixed-asset purchase and
    // mileage-trackable, in one step.
    let vehicleLabel: string | null = null;
    if (dto.newVehicleLabel) {
      if (dto.type !== 'asset') {
        throw new BadRequestException('NEW_VEHICLE_ONLY_FOR_ASSETS');
      }
      if (dto.vehicleName) {
        throw new BadRequestException('VEHICLE_CONFLICT');
      }
      const label = dto.newVehicleLabel.trim();
      if (!NAME_GUARD.test(label)) {
        throw new BadRequestException('VEHICLE_NAME_INVALID');
      }
      vehicleLabel = await this.ensureVehicleByLabel(client, portalUserId, label);
    }
    // Phase 4.2 — expense/asset entries may reference one of the tenant's
    // Vehicles (fuel, maintenance, repairs...). Foreign vehicle → 404.
    if (dto.vehicleName) {
      if (dto.type === 'income') {
        throw new BadRequestException('VEHICLE_ONLY_FOR_EXPENSE_OR_ASSET');
      }
      const vehicle = await this.erp.getResource<{ company?: string; portal_vehicle_name?: string }>('Vehicle', dto.vehicleName);
      if (vehicle?.company !== client.erpCompanyName) {
        throw new NotFoundException('VEHICLE_NOT_FOUND');
      }
      vehicleLabel = vehicle.portal_vehicle_name || dto.vehicleName;
    }
    // Cross-type guards: customer is income-only, asset detail asset-only.
    if (dto.customerName && dto.type !== 'income') {
      throw new BadRequestException('CUSTOMER_ONLY_FOR_INCOME');
    }
    if ((dto.assetPurchaseDate || dto.assetCostCents) && dto.type !== 'asset') {
      throw new BadRequestException('ASSET_DETAIL_ONLY_FOR_ASSETS');
    }
    // Phase 4.3 — an expense may tie to a previously entered asset. The
    // referenced JE must be a portal asset entry of THIS tenant — a foreign
    // JE is 404'd, exactly like a foreign account/vehicle.
    let tiedAssetVehicle: string | null = null;
    if (dto.assetRef) {
      if (dto.type !== 'expense') {
        throw new BadRequestException('ASSET_REF_ONLY_FOR_EXPENSES');
      }
      const je = await this.erp.getResource<{
        company?: string;
        portal_entry?: number;
        portal_asset_entry?: number;
        portal_asset_cost?: number;
        portal_vehicle_name?: string;
      }>('Journal Entry', dto.assetRef);
      const isAssetJe =
        je?.company === client.erpCompanyName &&
        Number(je?.portal_entry) === 1 &&
        (Number(je?.portal_asset_entry) === 1 || je?.portal_asset_cost != null);
      if (!isAssetJe) {
        throw new NotFoundException('ASSET_NOT_FOUND');
      }
      tiedAssetVehicle = (je.portal_vehicle_name as string) || null;
    }

    await this.ensureBooksMeta();

    const rate = dto.amountCents / 100; // exact cents → 2-decimal
    const abbr = this.abbrFor(client.erpCompanyName);
    const cash = 'Cash - ' + abbr;

    // expense/asset: money out (debit the account, credit Cash);
    // income: money in (debit Cash, credit the account).
    const lines =
      dto.type === 'income'
        ? [
            { account: cash, debit_in_account_currency: rate, credit_in_account_currency: 0 },
            { account: dto.accountName, debit_in_account_currency: 0, credit_in_account_currency: rate },
          ]
        : [
            { account: dto.accountName, debit_in_account_currency: rate, credit_in_account_currency: 0 },
            { account: cash, debit_in_account_currency: 0, credit_in_account_currency: rate },
          ];

    const payload: Record<string, unknown> = {
      company: client.erpCompanyName,
      posting_date: dto.date,
      voucher_type: 'Journal Entry',
      user_remark: dto.description,
      portal_entry: 1,
      portal_user_id: portalUserId,
      accounts: lines,
    };
    if (dto.type === 'income' && dto.customerName) {
      payload.portal_customer_name = dto.customerName;
    }
    if (vehicleLabel) {
      payload.portal_vehicle_name = vehicleLabel;
    }
    if (dto.type === 'asset') {
      payload.portal_asset_entry = 1;
      if (dto.assetPurchaseDate) payload.portal_asset_purchase_date = dto.assetPurchaseDate;
      // Vehicles ALWAYS carry cost basis + purchase date so they surface in
      // the Asset Register (which lists cost-basis entries only) — Hector's
      // choice: the register keeps its explicit-cost-basis filter, and the
      // vehicle flow guarantees the basis is there.
      const costCents = dto.assetCostCents ?? (vehicleLabel ? dto.amountCents : undefined);
      if (costCents) payload.portal_asset_cost = costCents / 100;
      if (vehicleLabel && !dto.assetPurchaseDate) payload.portal_asset_purchase_date = dto.date;
    }
    if (dto.assetRef) {
      payload.portal_asset_ref = dto.assetRef;
      // Tying an expense to a vehicle-asset also keeps the vehicle tag.
      if (tiedAssetVehicle && !vehicleLabel) payload.portal_vehicle_name = tiedAssetVehicle;
    }

    const name = await this.erp.createJournalEntry(payload);
    await this.erp.submitJournalEntry(name);

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId: client.id,
        action: 'books.entry.created',
        targetId: name,
      },
    });

    this.logger.log(
      'Portal entry by ' + portalUserId + ' → JE ' + name + ' (' + dto.type + ', ' + rate.toFixed(2) + ', ' + client.erpCompanyName + ')',
    );
    return { journalEntry: name };
  }

  // ── Phase 4.3: Assets (the expense tab's "tie to an asset" picker) ─────

  /**
   * The tenant's portal-entered assets. Includes entries tagged
   * portal_asset_entry (4.3 flow) AND older asset JEs that carry
   * portal_asset_cost, so pre-4.3 vehicle entries still show up in the
   * picker.
   */
  async listAssets(tenant: { clientId: string }): Promise<
    Array<{ id: string; date: string; description: string; cost: number | null; vehicleName: string | null; purchaseDate: string | null }>
  > {
    const client = await this.loadTenantBook(tenant);
    await this.ensureBooksMeta();
    const base: unknown[][] = [
      ['Journal Entry', 'company', '=', client.erpCompanyName],
      ['Journal Entry', 'portal_entry', '=', 1],
    ];
    const fields = ['name', 'posting_date', 'user_remark', 'portal_asset_cost', 'total_debit', 'portal_vehicle_name', 'portal_asset_purchase_date'];
    const [tagged, legacy] = await Promise.all([
      this.erp.listResource<Record<string, unknown>>({
        doctype: 'Journal Entry',
        filters: [...base, ['Journal Entry', 'portal_asset_entry', '=', 1]],
        fields,
        orderBy: 'posting_date desc',
        limit: 100,
      }),
      this.erp.listResource<Record<string, unknown>>({
        doctype: 'Journal Entry',
        filters: [...base, ['Journal Entry', 'portal_asset_cost', 'is', 'set']],
        fields,
        orderBy: 'posting_date desc',
        limit: 100,
      }),
    ]);
    const seen = new Set<string>();
    const out: Array<{ id: string; date: string; description: string; cost: number | null; vehicleName: string | null; purchaseDate: string | null }> = [];
    for (const je of [...tagged, ...legacy]) {
      const id = je.name as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        date: (je.posting_date as string) ?? '',
        description: (je.user_remark as string) ?? '',
        cost: je.portal_asset_cost != null ? Number(je.portal_asset_cost) : Number(je.total_debit ?? 0) || null,
        vehicleName: (je.portal_vehicle_name as string) ?? null,
        purchaseDate: (je.portal_asset_purchase_date as string) || null,
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Phase 4.3 — edit a previously entered asset (the Asset tab's list).
   * Only the asset METADATA changes: description (user_remark), cost basis,
   * purchase date, and the vehicle label (create-or-reuse via the same
   * ensureVehicleByLabel as entry creation). The posted GL lines of the
   * submitted Journal Entry are immutable — an amount/category correction
   * is a new entry, by design.
   *
   * The submitted JE rejects a plain REST PUT (UpdateAfterSubmitError on
   * non-allow_on_submit fields), so the write rides the whitelisted
   * frappe.client.set_value — every value is validated here BEFORE it
   * reaches ERPNext.
   */
  async updateAsset(
    tenant: { clientId: string },
    portalUserId: string,
    jeName: string,
    dto: UpdateAssetDto,
  ): Promise<{ ok: true }> {
    const client = await this.loadTenantBook(tenant);
    await this.ensureBooksMeta();

    // Same cross-tenant guarantee as the expense tie: the JE must be a
    // portal asset entry of THIS tenant — anything else is 404'd as
    // anti-enumeration.
    const je = await this.erp.getResource<{
      company?: string;
      portal_entry?: number;
      portal_asset_entry?: number;
      portal_asset_cost?: number;
    }>('Journal Entry', jeName);
    const isAssetJe =
      je?.company === client.erpCompanyName &&
      Number(je?.portal_entry) === 1 &&
      (Number(je?.portal_asset_entry) === 1 || je?.portal_asset_cost != null);
    if (!isAssetJe) {
      throw new NotFoundException('ASSET_NOT_FOUND');
    }

    const values: Record<string, unknown> = {};
    if (dto.description !== undefined) {
      const description = dto.description.trim();
      if (!description) throw new BadRequestException('DESCRIPTION_REQUIRED');
      if (description.length > 200) throw new BadRequestException('DESCRIPTION_TOO_LONG');
      values.user_remark = description;
    }
    if (dto.costCents !== undefined) {
      values.portal_asset_cost = dto.costCents / 100;
    }
    if (dto.purchaseDate !== undefined) {
      values.portal_asset_purchase_date = dto.purchaseDate;
    }
    if (dto.vehicleLabel !== undefined) {
      if (dto.vehicleLabel === '') {
        values.portal_vehicle_name = ''; // explicit clear of the vehicle tag
      } else {
        const label = dto.vehicleLabel.trim();
        if (!NAME_GUARD.test(label)) throw new BadRequestException('VEHICLE_NAME_INVALID');
        // Same create-or-reuse as entry creation — editing the vehicle
        // name is the SAME one-vehicle-concept step.
        values.portal_vehicle_name = await this.ensureVehicleByLabel(client, portalUserId, label);
      }
    }
    if (Object.keys(values).length === 0) return { ok: true }; // no-op save

    await this.erp.callMethod('frappe.client.set_value', {
      doctype: 'Journal Entry',
      name: jeName,
      fieldname: values,
    });

    await this.prisma.auditLog.create({
      data: { userId: portalUserId, clientId: client.id, action: 'books.asset.updated', targetId: jeName },
    });
    this.logger.log('Portal asset update ' + jeName + ' by ' + portalUserId + ' (' + Object.keys(values).join(', ') + ')');
    return { ok: true };
  }

  /**
   * Create-or-reuse a Vehicle by its tenant label (the asset-tab vehicle
   * field). Same docname namespacing rules as createVehicle: a docname
   * owned by a foreign tenant gets our abbr suffix instead of failing.
   * Returns the vehicle LABEL for the JE tag.
   */
  private async ensureVehicleByLabel(
    client: { id: string; erpCompanyName: string },
    portalUserId: string,
    label: string,
  ): Promise<string> {
    const mine = await this.erp.listResource<{ name: string }>({
      doctype: 'Vehicle',
      filters: [
        ['Vehicle', 'company', '=', client.erpCompanyName],
        ['Vehicle', 'portal_vehicle_name', '=', label],
      ],
      fields: ['name'],
      limit: 1,
    });
    if (mine.length > 0) return label;

    const abbr = this.abbrFor(client.erpCompanyName);
    let docname = label;
    const byDocname = await this.erp.getResource<{ company?: string }>('Vehicle', label);
    if (byDocname) {
      if (byDocname.company === client.erpCompanyName) {
        return label; // same docname, same tenant — reuse as is
      }
      docname = label + ' (' + abbr + ')';
      const dupe = await this.erp.getResource<{ company?: string }>('Vehicle', docname);
      if (dupe) {
        if (dupe.company === client.erpCompanyName) {
          return label;
        }
        throw new ConflictException('VEHICLE_NAME_CONFLICT');
      }
    }
    const name = await this.erp.createResource('Vehicle', {
      license_plate: docname,
      portal_vehicle_name: label,
      company: client.erpCompanyName,
      last_odometer: 0,
    });
    await this.prisma.auditLog.create({
      data: { userId: portalUserId, clientId: client.id, action: 'books.vehicle.created', targetId: name },
    });
    this.logger.log('Portal vehicle "' + label + '" by ' + portalUserId + ' → Vehicle ' + name);
    return label;
  }

  // ── Phase 4.2: Vehicles (ERPNext's NATIVE Vehicle doctype) ──────────────

  async createVehicle(
    tenant: { clientId: string },
    portalUserId: string,
    dto: { name: string },
  ): Promise<{ vehicle: string; label: string }> {
    const label = (dto.name ?? '').trim();
    if (!NAME_GUARD.test(label)) {
      throw new BadRequestException('VEHICLE_NAME_INVALID');
    }
    const client = await this.loadTenantBook(tenant);
    await this.erp.ensureVehicleDoctypes();

    // ERPNext's native Vehicle is one global namespace (license_plate,
    // with a unique key on it) — same shape as Customer. Same label in
    // this tenant → 409. Same label owned by a FOREIGN tenant →
    // namespace ours with the Company abbr instead of failing.
    const abbr = this.abbrFor(client.erpCompanyName);
    let docname = label;
    const existing = await this.erp.getResource<{ company?: string }>('Vehicle', label);
    if (existing) {
      if (existing.company === client.erpCompanyName) {
        throw new ConflictException('VEHICLE_EXISTS');
      }
      docname = label + ' (' + abbr + ')';
      const dupe = await this.erp.getResource<{ company?: string }>('Vehicle', docname);
      if (dupe) {
        if (dupe.company === client.erpCompanyName) {
          throw new ConflictException('VEHICLE_EXISTS');
        }
        throw new ConflictException('VEHICLE_NAME_CONFLICT');
      }
    }

    const name = await this.erp.createResource('Vehicle', {
      license_plate: docname,
      portal_vehicle_name: label,
      company: client.erpCompanyName,
      last_odometer: 0,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId: client.id,
        action: 'books.vehicle.created',
        targetId: name,
      },
    });

    this.logger.log('Portal vehicle "' + label + '" by ' + portalUserId + ' → Vehicle ' + name);
    return { vehicle: name, label };
  }

  async listVehicles(
    tenant: { clientId: string },
  ): Promise<Array<{ name: string; label: string; currentOdometer: number }>> {
    const client = await this.loadTenantBook(tenant);
    // portal_vehicle_name doesn't exist on a fresh site until the first
    // ensure — a list querying it would 417. Ensure (memoized) first.
    await this.ensureBooksMeta();
    const rows = await this.erp.listResource<{ name: string; portal_vehicle_name?: string; last_odometer?: number }>({
      doctype: 'Vehicle',
      filters: [['Vehicle', 'company', '=', client.erpCompanyName]],
      fields: ['name', 'portal_vehicle_name', 'last_odometer'],
      orderBy: 'creation desc',
      limit: 100,
    });
    return rows.map((v) => ({
      name: v.name,
      label: v.portal_vehicle_name || v.name,
      currentOdometer: Number(v.last_odometer ?? 0),
    }));
  }

  // ── Phase 4.2: Odometer readings (miles computed, not entered) ─────────

  /**
   * Log an odometer reading for a vehicle.
   * - FIRST reading for the vehicle = BASELINE: recorded, no miles, no JE.
   * - Reading must exceed the previous one (400 ODOMETER_NOT_INCREASING).
   * - purpose present → business trip: miles = reading − previous, JE
   *   auto-posted at the IRS rate (debit Vehicle Expenses, credit Cash).
   * - purpose absent → reading-only row (BOY/EOY odometer capture), no JE.
   */
  async createOdometerReading(
    tenant: { clientId: string },
    portalUserId: string,
    dto: CreateOdometerDto,
  ): Promise<{
    baseline: boolean;
    odometerLog: string;
    miles: number;
    journalEntry: string | null;
    amountCents: number | null;
  }> {
    const client = await this.loadTenantBook(tenant);
    await this.erp.ensureVehicleDoctypes();

    // Cross-tenant guarantee: the vehicle must belong to this tenant.
    const vehicle = await this.erp.getResource<{ company?: string; portal_vehicle_name?: string }>('Vehicle', dto.vehicle);
    if (vehicle?.company !== client.erpCompanyName) {
      throw new NotFoundException('VEHICLE_NOT_FOUND');
    }
    const vehicleLabel = vehicle.portal_vehicle_name || dto.vehicle;

    // Previous reading for this vehicle (latest by date, then creation).
    const prevRows = await this.erp.listResource<{ odometer?: number }>({
      doctype: 'Odometer Log',
      filters: [['Odometer Log', 'vehicle', '=', dto.vehicle]],
      fields: ['odometer'],
      orderBy: 'date desc, creation desc',
      limit: 1,
    });
    const prevOdometer = prevRows.length > 0 ? Number(prevRows[0].odometer ?? 0) : null;

    const purpose = dto.purpose?.trim() || undefined;

    // Baseline: first reading ever recorded for this vehicle.
    if (prevOdometer === null) {
      const log = await this.erp.createResource('Odometer Log', {
        vehicle: dto.vehicle,
        vehicle_name: vehicleLabel,
        date: dto.date,
        odometer: dto.odometer,
        miles: 0,
        rate: 0,
        amount: 0,
        purpose: purpose ?? '',
        company: client.erpCompanyName,
        portal_user_id: portalUserId,
      });
      await this.erp.updateResource('Vehicle', dto.vehicle, { last_odometer: dto.odometer });
      await this.prisma.auditLog.create({
        data: {
          userId: portalUserId,
          clientId: client.id,
          action: 'books.odometer.baseline',
          targetId: log,
        },
      });
      this.logger.log('Baseline odometer ' + dto.odometer + ' for ' + dto.vehicle + ' by ' + portalUserId);
      return { baseline: true, odometerLog: log, miles: 0, journalEntry: null, amountCents: null };
    }

    if (dto.odometer <= prevOdometer) {
      throw new BadRequestException('ODOMETER_NOT_INCREASING');
    }
    const miles = dto.odometer - prevOdometer;

    // Reading-only row: no JE, but still record the computed miles (the
    // diff is needed for BOY/EOY totals).
    if (!purpose) {
      const log = await this.erp.createResource('Odometer Log', {
        vehicle: dto.vehicle,
        vehicle_name: vehicleLabel,
        date: dto.date,
        odometer: dto.odometer,
        miles,
        rate: 0,
        amount: 0,
        purpose: '',
        company: client.erpCompanyName,
        portal_user_id: portalUserId,
      });
      await this.erp.updateResource('Vehicle', dto.vehicle, { last_odometer: dto.odometer });
      await this.prisma.auditLog.create({
        data: {
          userId: portalUserId,
          clientId: client.id,
          action: 'books.odometer.recorded',
          targetId: log,
        },
      });
      this.logger.log('Odometer ' + dto.odometer + ' (' + miles + ' mi) for ' + dto.vehicle + ' by ' + portalUserId + ' — no JE (reading only)');
      return { baseline: false, odometerLog: log, miles, journalEntry: null, amountCents: null };
    }

    // Business trip → auto-post the JE at the IRS rate (DECIDED Oct 2026).
    // Client-supplied per-trip rate (validated 1–1000 by the DTO) wins;
    // absent → the env default. Snapshot logic below is unchanged.
    const rateCents = dto.rateCents ?? this.mileageRateCents();
    const amountCents = Math.round(miles * rateCents);
    const abbr = this.abbrFor(client.erpCompanyName);
    const vehicleAccount = await this.erp.ensureMileageAccount(client.erpCompanyName, abbr);
    await this.ensureBooksMeta();

    const log = await this.erp.createResource('Odometer Log', {
      vehicle: dto.vehicle,
      vehicle_name: vehicleLabel,
      date: dto.date,
      odometer: dto.odometer,
      miles,
      rate: rateCents / 100,
      amount: amountCents / 100,
      purpose,
      company: client.erpCompanyName,
      portal_user_id: portalUserId,
    });

    const name = await this.erp.createJournalEntry({
      company: client.erpCompanyName,
      posting_date: dto.date,
      voucher_type: 'Journal Entry',
      user_remark: 'Mileage (' + vehicleLabel + '): ' + miles + ' mi — ' + purpose,
      portal_entry: 1,
      portal_user_id: portalUserId,
      odometer_log: log,
      accounts: [
        { account: vehicleAccount, debit_in_account_currency: amountCents / 100, credit_in_account_currency: 0 },
        { account: 'Cash - ' + abbr, debit_in_account_currency: 0, credit_in_account_currency: amountCents / 100 },
      ],
    });
    await this.erp.submitJournalEntry(name);
    await this.erp.updateResource('Odometer Log', log, { journal_entry: name });
    await this.erp.updateResource('Vehicle', dto.vehicle, { last_odometer: dto.odometer });

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId: client.id,
        action: 'books.odometer.created',
        targetId: name,
      },
    });

    this.logger.log(
      'Odometer trip by ' + portalUserId + ' → ODO ' + log + ' / JE ' + name + ' (' + miles + ' mi × ' + (rateCents / 100).toFixed(2) + ')',
    );
    return { baseline: false, odometerLog: log, miles, journalEntry: name, amountCents };
  }

  async listOdometer(tenant: { clientId: string }): Promise<
    Array<{
      id: string;
      vehicle: string;
      vehicleName: string;
      date: string;
      odometer: number;
      miles: number;
      rate: number;
      amount: number;
      purpose: string;
      journalEntry: string | null;
    }>
  > {
    const client = await this.loadTenantBook(tenant);
    // "Odometer Log" doesn't exist (and its permissions aren't patched)
    // on a fresh site until the first ensure — ensure (memoized) first.
    await this.ensureBooksMeta();
    const rows = await this.erp.listResource<Record<string, unknown>>({
      doctype: 'Odometer Log',
      filters: [['Odometer Log', 'company', '=', client.erpCompanyName]],
      fields: ['name', 'vehicle', 'vehicle_name', 'date', 'odometer', 'miles', 'rate', 'amount', 'purpose', 'journal_entry'],
      orderBy: 'date desc, creation desc',
      limit: 50,
    });
    return rows.map((m) => ({
      id: m.name as string,
      vehicle: (m.vehicle as string) ?? '',
      vehicleName: (m.vehicle_name as string) ?? '',
      date: (m.date as string) ?? '',
      odometer: Number(m.odometer ?? 0),
      miles: Number(m.miles ?? 0),
      rate: Number(m.rate ?? 0),
      amount: Number(m.amount ?? 0),
      purpose: (m.purpose as string) ?? '',
      journalEntry: (m.journal_entry as string) ?? null,
    }));
  }

  // ── Phase 4.2: Customers (income counterparties) ───────────────────────

  /**
   * Phase 4.2 — a Customer the tenant bills for income. Customer has no
   * native Company scope, so tenancy rides on Customer.portal_company
   * (custom Link field). Docnames are one global namespace: if another
   * tenant already owns the exact label, this tenant's copy is suffixed
   * with the Company abbr so both can coexist without leaking data.
   */
  async createCustomer(
    tenant: { clientId: string },
    portalUserId: string,
    dto: { name: string },
  ): Promise<{ customer: string }> {
    const label = (dto.name ?? '').trim();
    if (!NAME_GUARD.test(label)) {
      throw new BadRequestException('CUSTOMER_NAME_INVALID');
    }
    const client = await this.loadTenantBook(tenant);
    // loadTenantBook already rejected a null erpCompanyName at runtime,
    // but its inferred return type widens it back to string | null —
    // re-narrow for the compiler (same anti-enumeration 404 if ever hit).
    const company = client.erpCompanyName;
    if (!company) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }

    // Customer.portal_company (also ensured by the memoized meta path).
    await this.ensureBooksMeta();

    // Same label, same tenant → 409. Same label, FOREIGN tenant owns the
    // docname → namespace ours with the abbr instead of failing.
    const sameLabel = await this.erp.listResource<{ name: string; portal_company?: string }>({
      doctype: 'Customer',
      filters: [['Customer', 'customer_name', '=', label]],
      fields: ['name', 'portal_company'],
      limit: 1,
    });
    if (sameLabel.length > 0) {
      if (sameLabel[0].portal_company === company) {
        throw new ConflictException('CUSTOMER_EXISTS');
      }
      const abbr = this.abbrFor(company);
      const namespaced = label + ' (' + abbr + ')';
      const dupe = await this.erp.listResource<{ name: string; portal_company?: string }>({
        doctype: 'Customer',
        filters: [['Customer', 'customer_name', '=', namespaced]],
        fields: ['name', 'portal_company'],
        limit: 1,
      });
      if (dupe.length > 0) {
        if (dupe[0].portal_company === company) {
          throw new ConflictException('CUSTOMER_EXISTS');
        }
        throw new ConflictException('CUSTOMER_NAME_CONFLICT');
      }
      return this.insertCustomer(company, client.id, portalUserId, namespaced);
    }
    return this.insertCustomer(company, client.id, portalUserId, label);
  }

  /** Leaf (non-group) Customer Group / Territory used on Customer creation.
   *  ERPNext validates both against is_group=0 — the tree roots fail with
   *  417. Env-overridable so a site with existing leaf nodes can reuse them
   *  instead of the defaults. */
  private customerGroupDefault(): string {
    return process.env.ERP_CUSTOMER_GROUP ?? 'BGC Clients';
  }

  private territoryDefault(): string {
    return process.env.ERP_TERRITORY ?? 'United States';
  }

  /** Create the configured leaf Customer Group + Territory if the site
   *  doesn't have them yet. Memoized via ensureBooksMeta — runs once per
   *  process, not per customer. */
  private async ensureCustomerDefaults(): Promise<void> {
    const customerGroup = this.customerGroupDefault();
    if (!(await this.erp.getResource('Customer Group', customerGroup))) {
      await this.erp.createResource('Customer Group', {
        customer_group_name: customerGroup,
        is_group: 0,
      });
    }
    const territory = this.territoryDefault();
    if (!(await this.erp.getResource('Territory', territory))) {
      await this.erp.createResource('Territory', {
        territory_name: territory,
        is_group: 0,
        parent_territory: 'All Territories',
      });
    }
  }

  private async insertCustomer(
    companyName: string,
    clientId: string,
    portalUserId: string,
    customerName: string,
  ): Promise<{ customer: string }> {
    // Customer mandatory fields (417 otherwise): customer_group + territory.
    // BOTH must be LEAF nodes (is_group=0) — the tree roots hardcoded here
    // before were Group-type, and ERPNext rejects them with 417
    // "Cannot select a Group type Customer Group" (prod, Nov 5).
    // ensureCustomerDefaults() (memoized via ensureBooksMeta) creates the
    // configured leafs on sites that don't have them yet.
    const name = await this.erp.createResource('Customer', {
      customer_name: customerName,
      customer_type: 'Individual',
      customer_group: this.customerGroupDefault(),
      territory: this.territoryDefault(),
      portal_company: companyName,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId,
        action: 'books.customer.created',
        targetId: name,
      },
    });

    this.logger.log('Portal customer "' + customerName + '" by ' + portalUserId + ' → Customer ' + name);
    return { customer: name };
  }

  async listCustomers(tenant: { clientId: string }): Promise<Array<{ name: string }>> {
    const client = await this.loadTenantBook(tenant);
    // Customer.portal_company doesn't exist on a fresh site until the
    // first ensure — a list filtering on it would 417. Memoized first.
    await this.ensureBooksMeta();
    const rows = await this.erp.listResource<{ name: string }>({
      doctype: 'Customer',
      filters: [['Customer', 'portal_company', '=', client.erpCompanyName]],
      fields: ['name'],
      orderBy: 'creation desc',
      limit: 100,
    });
    return rows.map((c) => ({ name: c.name }));
  }

  /**
   * Customer-created category (phase 4.1): a leaf Account in the tenant's
   * chart under the type-appropriate group. root_type is inherited from
   * the parent group, so the new account shows up in listAccounts
   * automatically.
   */
  async createCategory(
    tenant: { clientId: string },
    portalUserId: string,
    dto: { type: string; label: string },
  ): Promise<{ account: string }> {
    if (!(dto.type in ROOT_TYPE_BY_ENTRY)) {
      throw new BadRequestException('type must be expense, income, or asset');
    }
    const label = (dto.label ?? '').trim();
    if (!NAME_GUARD.test(label)) {
      throw new BadRequestException('CATEGORY_LABEL_INVALID');
    }

    const client = await this.loadTenantBook(tenant);
    const rootType = ROOT_TYPE_BY_ENTRY[dto.type as EntryType];
    const abbr = this.abbrFor(client.erpCompanyName);

    // Dedupe on account_name within the Company — same label twice is a
    // mistake, not two categories.
    const dupes = await this.erp.listResource<{ name: string }>({
      doctype: 'Account',
      filters: [
        ['Account', 'company', '=', client.erpCompanyName],
        ['Account', 'account_name', '=', label],
      ],
      fields: ['name'],
      limit: 1,
    });
    if (dupes.length > 0) {
      throw new ConflictException('CATEGORY_EXISTS');
    }

    // Parent group: assets prefer the Fixed Assets group; everything else
    // hangs off the chart's top group for its root_type.
    let parent: string | null = null;
    if (dto.type === 'asset') {
      const fixed = await this.erp.getResource<{ name: string }>('Account', 'Fixed Assets - ' + abbr);
      if (fixed) parent = fixed.name;
    }
    if (!parent) {
      const roots = await this.erp.listResource<{ name: string }>({
        doctype: 'Account',
        filters: [
          ['Account', 'company', '=', client.erpCompanyName],
          ['Account', 'root_type', '=', rootType],
          ['Account', 'is_group', '=', 1],
          ['Account', 'parent_account', 'is', 'not set'],
        ],
        fields: ['name'],
        limit: 1,
      });
      parent = roots[0]?.name ?? null;
    }
    if (!parent) {
      throw new NotFoundException('CHART_ROOT_NOT_FOUND');
    }

    const name = await this.erp.createAccount({
      account_name: label,
      company: client.erpCompanyName,
      parent_account: parent,
      is_group: 0,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId: client.id,
        action: 'books.category.created',
        targetId: name,
      },
    });

    this.logger.log(
      'Portal category "' + label + '" by ' + portalUserId + ' → Account ' + name + ' (under ' + parent + ')',
    );
    return { account: name };
  }

  async listEntries(tenant: { clientId: string }): Promise<
    Array<{ id: string; date: string; description: string; category: string; total: number; status: string }>
  > {
    const client = await this.loadTenantBook(tenant);
    // Journal Entry.portal_entry doesn't exist on a fresh site until the
    // first ensure — a list filtering on it would 417. Memoized first.
    await this.ensureBooksMeta();
    const rows = await this.erp.listResource<Record<string, unknown>>({
      doctype: 'Journal Entry',
      filters: [
        ['Journal Entry', 'company', '=', client.erpCompanyName],
        ['Journal Entry', 'portal_entry', '=', 1],
      ],
      // Journal Entry has no "total" field — total_debit is the entry
      // amount (debit and credit always balance).
      fields: ['name', 'posting_date', 'user_remark', 'total_debit', 'docstatus'],
      orderBy: 'posting_date desc',
      limit: 50,
    });
    // Category enrichment (Nov 2026): users reconcile Recent Entries
    // against their bank statement, so each row must say WHERE the money
    // went — the non-Cash side of the JE. Portal entries are always
    // two-line (category account vs Cash - ABBR), so ONE child-table
    // query covers all rows; the label strips the " - ABBR" suffix to
    // match the category dropdowns (which show account_name).
    const categoryByJe = new Map<string, string>();
    if (rows.length > 0) {
      const abbr = this.abbrFor(client.erpCompanyName);
      const cash = 'Cash - ' + abbr;
      const suffix = ' - ' + abbr;
      const ids = rows.map((je) => je.name as string);
      let lines: Array<{ parent?: string; account?: string }> = [];
      try {
        lines = await this.erp.listResource<{ parent?: string; account?: string }>({
          doctype: 'Journal Entry Account',
          filters: [
            ['Journal Entry Account', 'parenttype', '=', 'Journal Entry'],
            ['Journal Entry Account', 'parent', 'in', ids],
          ],
          fields: ['parent', 'account'],
          limit: ids.length * 4,
        });
      } catch {
        // Some sites refuse list access on the child table — fall back to
        // per-doc fetches (getResource returns the full doc incl. accounts).
        this.logger.warn('Journal Entry Account list failed — falling back to per-doc fetch');
        for (const id of ids) {
          const doc = await this.erp.getResource<{ accounts?: Array<{ account?: string }> }>('Journal Entry', id);
          for (const a of doc?.accounts ?? []) {
            lines.push({ parent: id, account: a.account });
          }
        }
      }
      for (const l of lines) {
        if (!l.parent || !l.account) continue;
        if (l.account === cash) continue;
        if (!categoryByJe.has(l.parent)) {
          categoryByJe.set(
            l.parent,
            l.account.endsWith(suffix) ? l.account.slice(0, -suffix.length) : l.account,
          );
        }
      }
    }

    return rows.map((je) => ({
      id: je.name as string,
      date: je.posting_date as string,
      description: (je.user_remark as string) ?? '',
      category: categoryByJe.get(je.name as string) ?? '',
      total: Number(je.total_debit ?? 0),
      status: je.docstatus === 1 ? 'submitted' : 'draft',
    }));
  }

  /** Custom Fields tagging portal-created entries (idempotent). */
  private async ensurePortalCustomFields(): Promise<void> {
    const fields = [
      {
        docname: 'Journal Entry-portal_entry',
        fieldname: 'portal_entry',
        label: 'Portal Entry',
        fieldtype: 'Check',
      },
      {
        docname: 'Journal Entry-portal_user_id',
        fieldname: 'portal_user_id',
        label: 'Portal User',
        fieldtype: 'Data',
      },
      {
        docname: 'Journal Entry-portal_customer_name',
        fieldname: 'portal_customer_name',
        label: 'Portal Customer',
        fieldtype: 'Data',
      },
      {
        docname: 'Journal Entry-portal_vehicle_name',
        fieldname: 'portal_vehicle_name',
        label: 'Portal Vehicle',
        fieldtype: 'Data',
      },
      {
        docname: 'Journal Entry-odometer_log',
        fieldname: 'odometer_log',
        label: 'Odometer Log',
        fieldtype: 'Data',
      },
      {
        docname: 'Journal Entry-portal_asset_purchase_date',
        fieldname: 'portal_asset_purchase_date',
        label: 'Asset Purchase Date',
        fieldtype: 'Date',
      },
      {
        docname: 'Journal Entry-portal_asset_cost',
        fieldname: 'portal_asset_cost',
        label: 'Asset Cost Basis',
        fieldtype: 'Currency',
      },
      {
        docname: 'Journal Entry-portal_asset_entry',
        fieldname: 'portal_asset_entry',
        label: 'Portal Asset Entry',
        fieldtype: 'Check',
      },
      {
        docname: 'Journal Entry-portal_asset_ref',
        fieldname: 'portal_asset_ref',
        label: 'Tied Asset (Journal Entry)',
        fieldtype: 'Data',
      },
    ];
    for (const f of fields) {
      await this.erp.ensureCustomField({
        docname: f.docname,
        dt: 'Journal Entry',
        fieldname: f.fieldname,
        label: f.label,
        fieldtype: f.fieldtype,
        insertAfter: 'stripe_invoice_id',
      });
    }
  }
}
