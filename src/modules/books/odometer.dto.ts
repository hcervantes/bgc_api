import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Phase 4.2 (odometer revision, Oct 30, 2026) — a vehicle odometer reading.
 * The user logs READINGS, not miles: bgc-api computes miles from the
 * previous reading for that vehicle and posts the JE at the IRS rate.
 *
 * - First reading for a vehicle = BASELINE (recorded, no miles, no JE).
 * - purpose present → business trip → auto-posted Journal Entry.
 * - purpose absent → reading-only row (e.g. year-end odometer capture).
 */
export class CreateOdometerDto {
  @IsString()
  @IsNotEmpty({ message: 'vehicle is required' })
  vehicle!: string; // Vehicle docname, e.g. VEH-00001

  @IsDateString()
  date!: string; // YYYY-MM-DD

  @IsInt()
  @Min(1)
  @Max(10000000)
  odometer!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string; // absent → reading-only, no JE
}
