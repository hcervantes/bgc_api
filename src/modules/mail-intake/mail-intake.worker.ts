import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailEvent } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SpacesService } from '../../common/storage/spaces.service';
import { HostingerMailClient } from './hostinger-mail.client';
import { ClamAvService } from './clamav.service';
import { MAIL_EVENT_TYPES } from './mail-webhook.constants';

// Outcome contract (refines the MailEvent schema note):
// - PERMANENT rejections (unknown sender, AV infection, unparseable): row
//   marked FAILED with a short error, row kept (rawPayload preserved for
//   diagnosis), webhook still answers 200 — retrying would fail identically.
// - TRANSIENT failures (signed-URL download, Spaces error, clamd outage):
//   the row is DELETED and the error rethrown -> webhook 500 -> Hostinger
//   retry reprocesses from scratch (insert-first dedupe makes this safe).
//
// Attachment bytes come straight from the pre-signed URLs in the envelope
// (verified live Nov 2026) — no Mail API call, no second token. Bodies are
// kept in MailEvent.rawPayload; per-attachment Document rows are a later PR.
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

    const payload = event.rawPayload as any;
    const data = payload?.data ?? {};
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];

    // Exact match on the sender's From address vs Client.email (design
    // decision, Nov 2026). data.from is "Name <addr>" or a bare address.
    const from = this.extractAddress(String(data.from ?? ''));
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

    const stagedKeys: string[] = [];
    for (const att of attachments) {
      if (!att?.fileUrl || !att?.filename) {
        await this.fail(event, 'MALFORMED_ATTACHMENT');
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await this.mailApi.downloadSigned(att.fileUrl);
      } catch (err: any) {
        await this.transient(event, 'ATTACHMENT_DOWNLOAD: ' + (err?.message ?? String(err)));
        return;
      }
      try {
        const scan = await this.clamav.scan(bytes);
        if (!scan.ok) {
          await this.fail(event, 'AV_INFECTED: ' + (scan.signature ?? 'unknown') + ' (' + att.filename + ')');
          return;
        }
      } catch (err: any) {
        await this.transient(event, 'AV_SCAN: ' + (err?.message ?? String(err)));
        return;
      }
      const key = [client.slug, 'mail-staging', event.eventId, this.sanitize(att.filename)].join('/');
      try {
        const bucket = this.config.get<string>('DO_SPACES_BUCKET_DOCS') ?? 'bgc-tax-documents';
        await this.spaces.putObject(bucket, key, bytes, att.contentType ?? 'application/octet-stream');
      } catch (err: any) {
        await this.transient(event, 'SPACES_PUT: ' + (err?.message ?? String(err)));
        return;
      }
      stagedKeys.push(key);
    }

    await this.prisma.mailEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date(), error: null },
    });
    this.logger.log(
      'MailEvent PROCESSED: ' + event.eventId + ' — ' + stagedKeys.length + ' attachment(s) staged' +
      (stagedKeys.length ? ' (' + stagedKeys.join(', ') + ')' : '') +
      ' — ' + (attachments.length ? '' : 'no attachments') + from,
    );
  }

  /** "Name <addr>" or bare address -> lowercase addr. */
  private extractAddress(from: string): string | null {
    const m = from.match(/[\w.+-]+@[\w.-]+/);
    return m ? m[0].toLowerCase() : null;
  }

  private sanitize(filename: string): string {
    return filename.replace(/[^\w.\-]/g, '_').slice(-180) || 'attachment';
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
