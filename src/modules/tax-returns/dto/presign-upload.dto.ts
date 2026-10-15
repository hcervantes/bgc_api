import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class PresignUploadDto {
  @IsInt() @Min(2000) @Max(2100)
  taxYear: number;

  @IsIn(['individual', 'business', 'amended'])
  type: 'individual' | 'business' | 'amended';

  @IsString() @IsNotEmpty()
  originalFilename: string;
}
