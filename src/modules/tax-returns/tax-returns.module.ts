import { Module } from '@nestjs/common';
import { TaxReturnsController } from './tax-returns.controller';
import { TaxReturnsService } from './tax-returns.service';

@Module({ controllers: [TaxReturnsController], providers: [TaxReturnsService] })
export class TaxReturnsModule {}
