import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MailWebhookController } from './mail-webhook.controller';
import { MailWebhookService } from './mail-webhook.service';

// PR #A: webhook receiver only (verify, dedupe, record MailEvent).
// PR #B adds the intake worker (Mail API fetch, Spaces staging, ClamAV)
// and will import this module to reuse MailWebhookService.
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [MailWebhookController],
  providers: [MailWebhookService],
  exports: [MailWebhookService],
})
export class MailIntakeModule {}
