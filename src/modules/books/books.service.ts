import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from '../erpnext/erpnext-platform.service';
import { CreateEntryDto, EntryType } from './create-entry.dto';
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
const ASSET_EXCLUDED_TYPES = ['Cash', 'Bank', 'Receivable', 'Payable', 'Stock'];

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
 * - Vehicles: custom "Vehicle" doctype, tenant-scoped by company (format
 *   autoname VEH-##### — no global docname collisions).
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
  private async loadTenantBook(tenant: { clientId: string }) {
    const client = await this.prisma.client.findUnique({ where: { id: tenant.clientId } });
    if (!client) {
      // Not an error state to reveal: same 404 as a non-member tenant.
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    if (!client.bookkeepingEnabled || !client.erpCompanyName) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    return client;
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
    // Phase 4.2 — expense/asset entries may reference one of the tenant's
    // Vehicles (fuel, maintenance, repairs...). Foreign vehicle → 404.
    let vehicleLabel: string | null = null;
    if (dto.vehicleName) {
      if (dto.type === 'income') {
        throw new BadRequestException('VEHICLE_ONLY_FOR_EXPENSE_OR_ASSET');
      }
      const vehicle = await this.erp.getResource<{ company?: string; vehicle_name?: string }>('Vehicle', dto.vehicleName);
      if (vehicle?.company !== client.erpCompanyName) {
        throw new NotFoundException('VEHICLE_NOT_FOUND');
      }
      vehicleLabel = vehicle.vehicle_name ?? dto.vehicleName;
    }
    // Cross-type guards: customer is income-only, asset detail asset-only.
    if (dto.customerName && dto.type !== 'income') {
      throw new BadRequestException('CUSTOMER_ONLY_FOR_INCOME');
    }
    if ((dto.assetPurchaseDate || dto.assetCostCents) && dto.type !== 'asset') {
      throw new BadRequestException('ASSET_DETAIL_ONLY_FOR_ASSETS');
    }

    await this.ensurePortalCustomFields();

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
      if (dto.assetPurchaseDate) payload.portal_asset_purchase_date = dto.assetPurchaseDate;
      if (dto.assetCostCents) payload.portal_asset_cost = dto.assetCostCents / 100;
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

  // ── Phase 4.2: Vehicles (tenant-scoped custom doctype) ─────────────────

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

    // Per-Company label dedupe — two vehicles with the same name in one
    // tenant is a mistake. (Docnames never collide: format autoname.)
    const dupes = await this.erp.listResource<{ name: string }>({
      doctype: 'Vehicle',
      filters: [
        ['Vehicle', 'company', '=', client.erpCompanyName],
        ['Vehicle', 'vehicle_name', '=', label],
      ],
      fields: ['name'],
      limit: 1,
    });
    if (dupes.length > 0) {
      throw new ConflictException('VEHICLE_EXISTS');
    }

    const name = await this.erp.createResource('Vehicle', {
      vehicle_name: label,
      company: client.erpCompanyName,
      current_odometer: 0,
      portal_user_id: portalUserId,
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
    const rows = await this.erp.listResource<{ name: string; vehicle_name: string; current_odometer?: number }>({
      doctype: 'Vehicle',
      filters: [['Vehicle', 'company', '=', client.erpCompanyName]],
      fields: ['name', 'vehicle_name', 'current_odometer'],
      orderBy: 'creation desc',
      limit: 100,
    });
    return rows.map((v) => ({
      name: v.name,
      label: v.vehicle_name,
      currentOdometer: Number(v.current_odometer ?? 0),
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
    const vehicle = await this.erp.getResource<{ company?: string; vehicle_name?: string }>('Vehicle', dto.vehicle);
    if (vehicle?.company !== client.erpCompanyName) {
      throw new NotFoundException('VEHICLE_NOT_FOUND');
    }
    const vehicleLabel = vehicle.vehicle_name ?? dto.vehicle;

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
      await this.erp.updateResource('Vehicle', dto.vehicle, { current_odometer: dto.odometer });
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
    const trip = { ...dto, purpose };

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
      await this.erp.updateResource('Vehicle', dto.vehicle, { current_odometer: dto.odometer });
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
    const rateCents = this.mileageRateCents();
    const amountCents = Math.round(miles * rateCents);
    const abbr = this.abbrFor(client.erpCompanyName);
    const vehicleAccount = await this.erp.ensureMileageAccount(client.erpCompanyName, abbr);
    await this.ensurePortalCustomFields();

    const log = await this.erp.createResource('Odometer Log', {
      vehicle: dto.vehicle,
      vehicle_name: vehicleLabel,
      date: trip.date,
      odometer: trip.odometer,
      miles,
      rate: rateCents / 100,
      amount: amountCents / 100,
      purpose,
      company: client.erpCompanyName,
      portal_user_id: portalUserId,
    });

    const name = await this.erp.createJournalEntry({
      company: client.erpCompanyName,
      posting_date: trip.date,
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
    await this.erp.updateResource('Vehicle', dto.vehicle, { current_odometer: trip.odometer });

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

    await this.erp.ensureCustomField({
      docname: 'Customer-portal_company',
      dt: 'Customer',
      fieldname: 'portal_company',
      label: 'Portal Company',
      fieldtype: 'Link',
      options: 'Company',
      insertAfter: 'customer_group',
    });

    // Same label, same tenant → 409. Same label, FOREIGN tenant owns the
    // docname → namespace ours with the abbr instead of failing.
    const sameLabel = await this.erp.listResource<{ name: string; portal_company?: string }>({
      doctype: 'Customer',
      filters: [['Customer', 'customer_name', '=', label]],
      fields: ['name', 'portal_company'],
      limit: 1,
    });
    if (sameLabel.length > 0) {
      if (sameLabel[0].portal_company === client.erpCompanyName) {
        throw new ConflictException('CUSTOMER_EXISTS');
      }
      const abbr = this.abbrFor(client.erpCompanyName);
      const namespaced = label + ' (' + abbr + ')';
      const dupe = await this.erp.listResource<{ name: string; portal_company?: string }>({
        doctype: 'Customer',
        filters: [['Customer', 'customer_name', '=', namespaced]],
        fields: ['name', 'portal_company'],
        limit: 1,
      });
      if (dupe.length > 0) {
        if (dupe[0].portal_company === client.erpCompanyName) {
          throw new ConflictException('CUSTOMER_EXISTS');
        }
        throw new ConflictException('CUSTOMER_NAME_CONFLICT');
      }
      return this.insertCustomer(client.erpCompanyName, client.id, portalUserId, namespaced);
    }
    return this.insertCustomer(client.erpCompanyName, client.id, portalUserId, label);
  }

  private async insertCustomer(
    companyName: string,
    clientId: string,
    portalUserId: string,
    customerName: string,
  ): Promise<{ customer: string }> {
    // Customer mandatory fields (417 otherwise): customer_group + territory.
    const name = await this.erp.createResource('Customer', {
      customer_name: customerName,
      customer_type: 'Individual',
      customer_group: 'All Customer Groups',
      territory: 'All Territories',
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
    Array<{ id: string; date: string; description: string; total: number; status: string }>
  > {
    const client = await this.loadTenantBook(tenant);
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
    return rows.map((je) => ({
      id: je.name as string,
      date: je.posting_date as string,
      description: (je.user_remark as string) ?? '',
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
