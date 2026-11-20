import { Injectable, Logger } from '@nestjs/common';

// Hostinger's webhook envelope (verified against a live delivery, Nov 2026)
// carries pre-signed, expiring Google Storage URLs for the full message
// (data.bodyUrl) and each attachment (data.attachments[].fileUrl). This
// downloads those URLs so the worker can scan and stage the bytes. No Mail
// API token is needed on the intake path.
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

@Injectable()
export class HostingerMailClient {
  private readonly logger = new Logger(HostingerMailClient.name);

  /** Download a pre-signed Hostinger attachment/body URL, size-capped. */
  async downloadSigned(url: string): Promise<Buffer> {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('DOWNLOAD_HTTP_' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('DOWNLOAD_TOO_LARGE');
    this.logger.log('Downloaded signed content (' + buf.length + ' bytes)');
    return buf;
  }
}
