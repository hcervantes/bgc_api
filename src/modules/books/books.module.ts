import { Module } from '@nestjs/common';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ErpNextModule } from '../erpnext/erpnext.module';

@Module({
  imports: [ErpNextModule],
  controllers: [BooksController, ReportsController],
  providers: [BooksService, ReportsService],
})
export class BooksModule {}
