import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export type EntryType = 'expense' | 'income' | 'asset';

/**
 * A customer-entered bookkeeping entry (Standard tier). accountName MUST
 * be one of the tenant's own CoA accounts (validated server-side against
 * the tenant's Company — a foreign account name is a cross-tenant write
 * attempt and gets 404'd, never executed).
 *
 * Phase 4.2 optional fields:
 * - customerName (income only): full Customer docname, validated against
 *   Customer.portal_company == the tenant's Company, else 404.
 * - assetPurchaseDate / assetCostCents (asset only): asset detail stored
 *   on the Journal Entry as custom fields for later reporting.
 */
export class CreateEntryDto {
  @IsIn(['expense', 'income', 'asset'])
  type!: EntryType;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsDateString()
  date!: string; // YYYY-MM-DD

  @IsString()
  @IsNotEmpty({ message: 'description is required' })
  description!: string;

  @IsString()
  @IsNotEmpty({ message: 'accountName is required' })
  accountName!: string; // full docname, e.g. "Office Supplies - NC"

  @IsOptional()
  @IsString()
  customerName?: string; // full Customer docname, income entries only

  @IsOptional()
  @IsDateString()
  assetPurchaseDate?: string; // asset entries only

  @IsOptional()
  @IsInt()
  @Min(1)
  assetCostCents?: number; // asset entries only
}
