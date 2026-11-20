import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MailEvent } from '@prisma/client';
import { SpacesService } from '../../common/storage/spaces.service';
import { HostingerMailClient } from './hostinger-mail.client';
import { ClamAvService } from './clamav.service';
import { MAIL_EVENT_TYPES } from './mail-webhook.constants';

// Outcome contract (refines the MailEvent schema note):
// - PERMANENT rejections (unknown sender, AV infection): row marked FAILED
//   with a short error, row kept (rawPayload preserved for diagnosis),
//   webhook still answers 200 — retrying would fail identically.
// - TRANSIENT failures (Mail API 5xx, Spaces error, clamd outage): the row
//   is DELETED and the error rethrown -> webhook 500 -> Hostinger retry
//   reprocesses from scratch (insert-first dedupe makes this safe).
@Injectable()
export class MailIntakeWorkerService {
  private readonly logger = new Logger(MailIntakeWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mailApi: HostingerMailClient,
    private readonly spaces: SpacesService,
    private readonly clamav: ClamAvService,
  ) {}

  async process(event: MailEvent): Promise<void> {
    if (event.eventType !== MAIL_EVENT_TYPES.MESSAGE_RECEIVED) return;
    if (!event.messageId) {
      await this.fail(event, 'NO_MESSAGE_ID');
      return;
    }

    let fetched;
    try {
      fetched = await this.mailApi.fetchMessage(event.messageId);
    } catch (err: any) {
      await this.transient(event, 'MAIL_FETCH: ' + (err?.message ?? String(err)));
      return;
    }

    // Exact match on the sender's From address vs Client.email (design
    // decision, Nov 2026). Case-insensitive on both sides.
    const from = fetched.from;
    if (!from) {
      await this.fail(event, 'UNPARSEABLE_FROM');
      return;
    }
    const client = await this.prisma.client.findFirst({
      where: { email: from },
      select: { id: true, slug: true },
    });
    if (!client) {
      await this.fail(event, 'NO_MATCHING_CLIENT: ' + from);
      return;
    }

    try {
      const scan = await this.clamav.scan(fetched.raw);
      if (!scan.ok) {
        await this.fail(event, 'AV_INFECTED: ' + (scan.signature ?? 'unknown'));
        return;
      }
    } catch (err: any) {
      await this.transient(event, 'AV_SCAN: ' + (err?.message ?? String(err)));
      return;
    }

    const bucket = this.config.get<string>('DO_SPACES_BUCKET_DOCS') ?? 'bgc-tax-documents';
    const key = [client.slug, 'mail-staging', event.messageId + '.eml'].join('/');
    try {
      await this.spaces.putObject(bucket, key, fetched.raw, 'message/rfc822');
    } catch (err: any) {
      await this.transient(event, 'SPACES_PUT: ' + (err?.message ?? String(err)));
      return;
    }

    await this.prisma.mailEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date(), error: null },
    });
    this.logger.log('MailEvent PROCESSED: ' + event.eventId + ' staged at ' + key);
  }

  /** Permanent: keep the row, record why, webhook stays 200. */
  private async fail(event: MailEvent, reason: string): Promise<void> {
    this.logger.warn('MailEvent FAILED: ' + event.eventId + ' — ' + reason);
    await this.prisma.mailEvent.update({
      where: { id: event.id },
      data: { status: 'FAILED', error: reason.slice(0, 500) },
    });
  }

  /** Transient: delete the dedupe row so a Hostinger retry reprocesses. */
  private async transient(event: MailEvent, reason: string): Promise<void> {
    this.logger.warn('MailEvent transient failure: ' + event.eventId + ' — ' + reason);
    await this.prisma.mailEvent.delete({ where: { id: event.id } });
    throw new Error('MAIL_INTAKE_TRANSIENT: ' + reason);
  }
}
