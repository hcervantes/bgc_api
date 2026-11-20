import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SpacesModule } from '../../common/storage/spaces.module';
import { MailWebhookController } from './mail-webhook.controller';
import { MailWebhookService } from './mail-webhook.service';
import { MailIntakeWorkerService } from './mail-intake.worker';
import { HostingerMailClient } from './hostinger-mail.client';
import { ClamAvService } from './clamav.service';

// PR #A: webhook receiver (verify, dedupe, record MailEvent) — MERGED.
// PR #B (this branch): inline intake worker — Mail API fetch, exact
// sender->Client match, clamd INSTREAM scan, DO Spaces staging,
// PROCESSED/FAILED outcome contract (see mail-intake.worker.ts).
@Module({
  imports: [PrismaModule, SpacesModule, ConfigModule],
  controllers: [MailWebhookController],
  providers: [MailWebhookService, MailIntakeWorkerService, HostingerMailClient, ClamAvService],
  exports: [MailWebhookService],
})
export class MailIntakeModule {}
