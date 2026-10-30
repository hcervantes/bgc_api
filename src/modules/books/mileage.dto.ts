import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Phase 4.2 — a logged business trip. The Journal Entry amount is
 * computed server-side (miles × the configured IRS standard mileage rate);
 * the client never sends money values for mileage, only the raw trip.
 */
export class CreateMileageDto {
  @IsDateString()
  date!: string; // YYYY-MM-DD

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  miles!: number;

  @IsString()
  @IsNotEmpty({ message: 'purpose is required' })
  @MaxLength(500)
  purpose!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  vehicle?: string;
}
