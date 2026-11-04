import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from '../erpnext/erpnext-platform.service';
import { ReportKey, RunReportDto } from './reports-query.dto';

export interface ReportColumn {
  label: string;
  fieldname: string;
  type: string;
}

export interface ReportResult {
  key: ReportKey;
  title: string;
  fromDate: string;
  toDate: string;
  columns: ReportColumn[];
  /** Keyed objects — the portal never indexes row arrays by position. */
  rows: Array<Record<string, unknown>>;
}

interface ReportDef {
  title: string;
  /** Frappe script-report name; null = our own aggregation below. */
  frappeReport: string | null;
  /** Date-ranged report vs point-in-time (Balance Sheet). */
  ranged: boolean;
}

const REPORTS: Record<ReportKey, ReportDef> = {
  pnl: { title: 'Profit and Loss', frappeReport: 'Profit and Loss Statement', ranged: true },
  balance_sheet: { title: 'Balance Sheet', frappeReport: 'Balance Sheet', ranged: false },
  general_ledger: { title: 'General Ledger', frappeReport: 'General Ledger', ranged: true },
  trial_balance: { title: 'Trial Balance', frappeReport: 'Trial Balance', ranged: true },
  mileage_summary: { title: 'Mileage Summary', frappeReport: null, ranged: true },
  asset_register: { title: 'Asset Register', frappeReport: null, ranged: true },
};

/**
 * Phase 4.3 — the tenant's Books Reports tab.
 *
 * Two report families:
 *  1. STANDARD Frappe script reports (P&L, Balance Sheet, General Ledger,
 *     Trial Balance) executed via the whitelisted frappe.desk.query_report.run
 *     method (same callMethod path proven by the 4.2 permission fixes). The
 *     company filter is set SERVER-SIDE from the TenantGuard's Client row
 *     ONLY — the request never carries a company name, so a foreign tenant
 *     can never read another Company's numbers.
 *  2. OUR OWN aggregations over portal-owned docs (Odometer Log → Mileage
 *     Summary; portal asset Journal Entries → Asset Register). Creating v16
 *     Query Reports over REST is a developer-mode/permission minefield, so
 *     these use the plain listResource patterns proven in 4.2 — revisit as
 *     real Query Reports only if data volume demands it.
 *
 * 1099 Register: DEFERRED to phase 4.4 (Contractors/1099) — Suppliers and
 * the is_1099/W-9 machinery don't exist yet; a placeholder would render a
 * stub, not data. Do NOT add the key to REPORT_KEYS before 4.4.
 *
 * Fresh-site pattern (phase 4.2 lesson): the custom fields these READ paths
 * query (Journal Entry.portal_entry / portal_asset_*) are ensured ahead of
 * any read via the memoized ensureReportsMeta — a read filtering a
 * non-existent custom field 417s with 'Field not permitted in query'.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  /** Memo for ensureReportsMeta — reset on failure (same pattern as
   *  BooksService.ensureBooksMeta: a transient ERPNext outage must not be
   *  cached as a permanent rejection). */
  private reportsMetaEnsure: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpPlatformService,
  ) {}

  /** Mirror of BooksService.loadTenantBook (private there) — same
   *  anti-enumeration 404s. TODO(4.3 review): extract a shared tenant
   *  loader once the draft is reviewed. */
  private async loadTenantBook(tenant: { clientId: string }) {
    const client = await this.prisma.client.findUnique({ where: { id: tenant.clientId } });
    if (!client) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    if (!client.bookkeepingEnabled || !client.erpCompanyName) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    return client;
  }

  /** The catalog for the Reports tab UI. */
  catalog(): Array<{ key: ReportKey; title: string; ranged: boolean }> {
    return (Object.keys(REPORTS) as ReportKey[]).map((key) => ({
      key,
      title: REPORTS[key].title,
      ranged: REPORTS[key].ranged,
    }));
  }

  async runReport(tenant: { clientId: string }, key: string, dto: RunReportDto): Promise<ReportResult> {
    if (!(key in REPORTS)) {
      throw new NotFoundException('REPORT_NOT_FOUND');
    }
    const def = REPORTS[key as ReportKey];
    const client = await this.loadTenantBook(tenant);
    // Re-narrow for the compiler (loadTenantBook's inferred return widens
    // erpCompanyName back to string | null — same 4.2 pattern).
    const companyName = client.erpCompanyName;
    if (!companyName) {
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    const range = this.resolveRange(dto, def.ranged);

    if (def.frappeReport) {
      return this.runFrappeReport(key as ReportKey, def, companyName, range);
    }
    await this.ensureReportsMeta();
    return key === 'mileage_summary'
      ? this.mileageSummary(companyName, range)
      : this.assetRegister(companyName, range);
  }

  private resolveRange(dto: RunReportDto, ranged: boolean): { fromDate: string; toDate: string } {
    const year = new Date().getFullYear();
    const defaultFrom = year + '-01-01';
    const defaultTo = new Date().toISOString().slice(0, 10);
    // Balance Sheet is point-in-time: range only drives its default label.
    const fromDate = ranged ? dto.fromDate ?? defaultFrom : dto.fromDate ?? defaultFrom;
    const toDate = ranged ? dto.toDate ?? defaultTo : dto.toDate ?? defaultTo;
    if (fromDate > toDate) {
      throw new BadRequestException('DATES_INVALID');
    }
    return { fromDate, toDate };
  }

  /**
   * Standard Frappe script report via frappe.desk.query_report.run.
   * Response shape: { result: row ARRAYS aligned with columns, columns: [{label, fieldname, fieldtype}] }.
   * Column labels can carry HTML — strip it. Normalize rows to keyed objects.
   */
  private async runFrappeReport(
    key: ReportKey,
    def: ReportDef,
    companyName: string,
    range: { fromDate: string; toDate: string },
  ): Promise<ReportResult> {
    // SERVER-SIDE company scope — never accepts a company from the wire.
    // v16 filter contracts, verified against bgc-dev sources:
    //  - financial statements (P&L / Balance Sheet) branch on
    //    filter_based_on; 'Date Range' drives period_start_date/
    //    period_end_date. Sending from_date/to_date here leaves the
    //    validator with None dates ('From Date and To Date are mandatory').
    //  - General Ledger / Trial Balance still read from_date/to_date.
    const filters: Record<string, unknown> = { company: companyName };
    if (key === 'pnl' || key === 'balance_sheet') {
      filters.filter_based_on = 'Date Range';
      filters.period_start_date = range.fromDate;
      filters.period_end_date = range.toDate;
      filters.periodicity = 'Yearly';
    } else if (key === 'trial_balance') {
      // TB derives year_start_date/year_end_date from a named fiscal year
      // and clamps the requested range to it ('Fiscal Year None is required').
      filters.fiscal_year = range.fromDate.slice(0, 4);
      filters.from_date = range.fromDate;
      filters.to_date = range.toDate;
    } else {
      // General Ledger reads plain from_date/to_date.
      filters.from_date = range.fromDate;
      filters.to_date = range.toDate;
    }

    // run() is annotated `filters: str | dict` — a plain dict in the JSON
    // body arrives intact (verified via bench console on bgc-dev).
    const res = (await this.erp.callMethod('frappe.desk.query_report.run', {
      report_name: def.frappeReport,
      filters,
    })) as { result?: unknown[][]; columns?: unknown[] } | undefined;

    const rawCols = res?.columns;
    const rawRows = res?.result;
    if (!Array.isArray(rawCols) || !Array.isArray(rawRows)) {
      throw new Error(
        'query_report.run returned no result/columns for ' + def.frappeReport + ': ' +
          JSON.stringify(res).slice(0, 200),
      );
    }

    const columns: ReportColumn[] = rawCols.map((c) => {
      const col = c as { label?: string; fieldname?: string; fieldtype?: string };
      return {
        label: String(col.label ?? col.fieldname ?? '').replace(/<[^>]*>/g, '').trim(),
        fieldname: String(col.fieldname ?? col.label ?? ''),
        type: String(col.fieldtype ?? 'Data'),
      };
    });

    // Row shapes differ by report family: GL/TB return positional
    // ARRAYS; the financial statements return keyed OBJECTS. Handle
    // both — array rows zip with columns, object rows read by fieldname
    // (positional indexing on an object silently produced all-null rows,
    // the bgc-dev TB finding).
    const rows = rawRows.map((r) => {
      const row: Record<string, unknown> = {};
      if (r && !Array.isArray(r) && typeof r === 'object') {
        for (const c of columns) {
          row[c.fieldname] = (r as Record<string, unknown>)[c.fieldname] ?? null;
        }
      } else {
        columns.forEach((c, i) => {
          row[c.fieldname] = (r as unknown[])[i] ?? null;
        });
      }
      return row;
    });

    return {
      key,
      title: def.title,
      fromDate: range.fromDate,
      toDate: range.toDate,
      columns,
      rows,
    };
  }

  /** Mileage Summary — per-vehicle aggregation of Odometer Log rows.
   *  Business miles = rows WITH a purpose (trips, which posted JEs);
   *  other miles = reading-only rows (IRS wants BOY/EOY capture). */
  private async mileageSummary(
    companyName: string,
    range: { fromDate: string; toDate: string },
  ): Promise<ReportResult> {
    const rows = await this.erp.listResource<Record<string, unknown>>({
      doctype: 'Odometer Log',
      filters: [
        ['Odometer Log', 'company', '=', companyName],
        ['Odometer Log', 'date', '>=', range.fromDate],
        ['Odometer Log', 'date', '<=', range.toDate],
      ],
      fields: ['vehicle_name', 'miles', 'amount', 'purpose'],
      orderBy: 'date asc',
      limit: 1000,
    });

    const columns: ReportColumn[] = [
      { label: 'Vehicle', fieldname: 'vehicle', type: 'Data' },
      { label: 'Business Miles', fieldname: 'business_miles', type: 'Float' },
      { label: 'Other Miles', fieldname: 'other_miles', type: 'Float' },
      { label: 'Trips', fieldname: 'trips', type: 'Int' },
      { label: 'Mileage Amount', fieldname: 'amount', type: 'Currency' },
    ];

    const byVehicle = new Map<string, { vehicle: string; businessMiles: number; otherMiles: number; trips: number; amount: number }>();
    for (const r of rows) {
      const vehicle = (r.vehicle_name as string) || '(unnamed)';
      const agg =
        byVehicle.get(vehicle) ?? { vehicle, businessMiles: 0, otherMiles: 0, trips: 0, amount: 0 };
      const miles = Number(r.miles ?? 0);
      if ((r.purpose as string)?.trim()) {
        agg.businessMiles += miles;
        agg.trips += 1;
        agg.amount += Number(r.amount ?? 0);
      } else {
        agg.otherMiles += miles;
      }
      byVehicle.set(vehicle, agg);
    }

    const out = Array.from(byVehicle.values()).map((a) => ({
      vehicle: a.vehicle,
      business_miles: a.businessMiles,
      other_miles: a.otherMiles,
      trips: a.trips,
      amount: a.amount,
    }));
    out.push({
      vehicle: 'Total',
      business_miles: out.reduce((s, r) => s + r.business_miles, 0),
      other_miles: out.reduce((s, r) => s + r.other_miles, 0),
      trips: out.reduce((s, r) => s + r.trips, 0),
      amount: out.reduce((s, r) => s + r.amount, 0),
    });

    return {
      key: 'mileage_summary',
      title: 'Mileage Summary',
      fromDate: range.fromDate,
      toDate: range.toDate,
      columns,
      rows: out,
    };
  }

  /** Asset Register — the tenant's portal-entered asset purchases:
   *  Journal Entries tagged with portal_asset_cost (phase 4.2 custom
   *  fields), with purchase date + cost basis for the year-end package. */
  private async assetRegister(
    companyName: string,
    range: { fromDate: string; toDate: string },
  ): Promise<ReportResult> {
    const rows = await this.erp.listResource<Record<string, unknown>>({
      doctype: 'Journal Entry',
      filters: [
        ['Journal Entry', 'company', '=', companyName],
        ['Journal Entry', 'posting_date', '>=', range.fromDate],
        ['Journal Entry', 'posting_date', '<=', range.toDate],
        ['Journal Entry', 'portal_entry', '=', 1],
        ['Journal Entry', 'portal_asset_cost', 'is', 'set'],
      ],
      fields: ['name', 'posting_date', 'portal_asset_purchase_date', 'portal_asset_cost', 'user_remark'],
      orderBy: 'posting_date desc',
      limit: 200,
    });

    const columns: ReportColumn[] = [
      { label: 'Purchase Date', fieldname: 'purchase_date', type: 'Date' },
      { label: 'Description', fieldname: 'description', type: 'Data' },
      { label: 'Cost Basis', fieldname: 'cost', type: 'Currency' },
      { label: 'Journal Entry', fieldname: 'journal_entry', type: 'Link' },
    ];

    return {
      key: 'asset_register',
      title: 'Asset Register',
      fromDate: range.fromDate,
      toDate: range.toDate,
      columns,
      rows: rows.map((je) => ({
        purchase_date: (je.portal_asset_purchase_date as string) ?? (je.posting_date as string) ?? '',
        description: (je.user_remark as string) ?? '',
        cost: Number(je.portal_asset_cost ?? 0),
        journal_entry: je.name as string,
      })),
    };
  }

  /**
   * ONE-SHOT per process: the custom fields the report READ paths query.
   * Journal Entry.portal_entry / portal_asset_purchase_date /
   * portal_asset_cost are created by the 4.2 write paths lazily — on a
   * fresh site a report GET filtering them would 417. Memoized, reset
   * on failure (4.2 pattern).
   */
  private ensureReportsMeta(): Promise<void> {
    this.reportsMetaEnsure ??= (async () => {
      // Odometer Log (+ its permissions) for the Mileage Summary.
      await this.erp.ensureVehicleDoctypes();
      await this.erp.ensureCustomField({
        docname: 'Journal Entry-portal_entry',
        dt: 'Journal Entry',
        fieldname: 'portal_entry',
        label: 'Portal Entry',
        fieldtype: 'Check',
        insertAfter: 'stripe_invoice_id',
      });
      await this.erp.ensureCustomField({
        docname: 'Journal Entry-portal_asset_purchase_date',
        dt: 'Journal Entry',
        fieldname: 'portal_asset_purchase_date',
        label: 'Asset Purchase Date',
        fieldtype: 'Date',
        insertAfter: 'stripe_invoice_id',
      });
      await this.erp.ensureCustomField({
        docname: 'Journal Entry-portal_asset_cost',
        dt: 'Journal Entry',
        fieldname: 'portal_asset_cost',
        label: 'Asset Cost Basis',
        fieldtype: 'Currency',
        insertAfter: 'stripe_invoice_id',
      });
    })().catch((err) => {
      this.reportsMetaEnsure = null;
      throw err;
    });
    return this.reportsMetaEnsure;
  }

  /** CSV export — one header line + rows, RFC-4180 quoting. */
  toCsv(result: ReportResult): string {
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[","]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [result.columns.map((c) => esc(c.label)).join(',')];
    for (const row of result.rows) {
      lines.push(result.columns.map((c) => esc(row[c.fieldname])).join(','));
    }
    return lines.join('\n');
  }
}
