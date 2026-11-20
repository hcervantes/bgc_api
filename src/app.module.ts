import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './common/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClientsModule } from './modules/clients/clients.module';
import { ErpNextModule } from './modules/erpnext/erpnext.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { TaxReturnsModule } from './modules/tax-returns/tax-returns.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { BooksModule } from './modules/books/books.module';

// Mail intake moved to bgc_portal (PR #141 there) — the portal owns
// Document rows and the Spaces/ClamAV pipeline, so the Hostinger webhook
// receiver + worker (formerly this app's mail-intake module, PRs #31/#32)
// was removed in this PR.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    ClientsModule,
    ErpNextModule,
    DocumentsModule,
    TaxReturnsModule,
    StripeModule,
    BooksModule,
  ],
})
export class AppModule {}
