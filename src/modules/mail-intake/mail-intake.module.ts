import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SpacesModule } from '../../common/storage/spaces.module';
import { MailWebhookController } from './mail-webhook.controller';
import { MailWebhookService } from './mail-webhook.service';
import { MailIntakeWorkerService } from './mail-intake.worker';
import { HostingerMailClient } from './hostinger-mail.client';
import { ClamAvService } from './clamav.service';

// PR #A: webhook receiver — MERGED (#31).
// PR #B (this branch): inline intake worker — the live-verified envelope
// (id/event/timestamp + data{from, mailboxAddress, attachments[].fileUrl})
// drives everything: exact sender->Client match, per-attachment signed-URL
// download, clamd scan, Spaces staging under the client's slug.
@Module({
  imports: [PrismaModule, SpacesModule, ConfigModule],
  controllers: [MailWebhookController],
  providers: [MailWebhookService, MailIntakeWorkerService, HostingerMailClient, ClamAvService],
  exports: [MailWebhookService],
})
export class MailIntakeModule {}
