import { IsDateString, IsOptional } from 'class-validator';

/**
 * Phase 4.3 — query params for GET /v1/clients/:clientId/books/reports/:reportKey
 * (and /download). The tenant Company is NEVER a parameter: it comes from
 * the TenantGuard session server-side, same cross-tenant guarantee as the
 * 4.x write paths. Dates are optional; absent → year-to-date default.
 */
export const REPORT_KEYS = [
  'pnl',
  'balance_sheet',
  'general_ledger',
  'trial_balance',
  'mileage_summary',
  'asset_register',
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export class RunReportDto {
  /** YYYY-MM-DD, optional. Default: January 1 of the current year. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  /** YYYY-MM-DD, optional. Default: today. */
  @IsOptional()
  @IsDateString()
  toDate?: string;
}
