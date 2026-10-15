import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class PresignUploadDto {
  @IsInt() @Min(2000) @Max(2100)
  taxYear: number;

  @IsIn(['w2', 'other1099', 'prior_return', 'id_doc', 'misc'])
  type: 'w2' | 'other1099' | 'prior_return' | 'id_doc' | 'misc';

  @IsString() @IsNotEmpty()
  originalFilename: string;
}
