import { Module } from '@nestjs/common';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';
import { ErpNextModule } from '../erpnext/erpnext.module';

@Module({
  imports: [ErpNextModule],
  controllers: [BooksController],
  providers: [BooksService],
})
export class BooksModule {}
