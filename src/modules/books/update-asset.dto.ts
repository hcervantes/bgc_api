import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Phase 4.3 — edit a previously entered asset (the Asset tab's list).
 * Every field is optional; only provided fields change.
 *
 * Semantics:
 * - description: trimmed, non-empty, ≤ 200 chars.
 * - costCents: updates the portal_asset_cost basis (the Asset Register
 *   filter) — NOT the posted GL lines, which are immutable on a
 *   submitted Journal Entry.
 * - purchaseDate: updates the portal_asset_purchase_date custom field.
 * - vehicleLabel: a plain vehicle NAME — created-or-reused exactly like
 *   entry creation (one vehicle concept). An EMPTY string clears the
 *   vehicle tag; omitting the field leaves it unchanged.
 */
export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  costCents?: number;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string; // YYYY-MM-DD

  @IsOptional()
  @IsString()
  vehicleLabel?: string; // '' clears the vehicle tag
}
