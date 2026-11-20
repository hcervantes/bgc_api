import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FetchedMessage {
  /** Raw RFC822 message bytes from GET .../messages/{uid}/source. */
  raw: Buffer;
  /** Sender address from the message metadata (From).address, with an
   *  RFC822-header fallback when metadata lacks it. Lowercased. */
  from: string | null;
}

// Hostinger Mail API client per the official OpenAPI spec
// (github.com/hostinger/mail-api). Base: https://api.mail.hostinger.com,
// Bearer HOSTINGER_MAIL_API_TOKEN (order-scoped, optionally restricted to
// mailboxes; separate token from the webhook secret).
//
// Endpoints used:
//   GET /api/v1/me                                                       -> resolve mailboxResourceId by address
//   GET /api/v1/mailboxes/{id}/folders/{folder}/messages/{uid}           -> metadata (from.address, messageId)
//   GET /api/v1/mailboxes/{id}/folders/{folder}/messages/{uid}/source    -> raw RFC822 (message/rfc822)
@Injectable()
export class HostingerMailClient {
  private readonly logger = new Logger(HostingerMailClient.name);
  /** address(lowercase) -> mailboxResourceId (AC...) */
  private readonly mailboxIds = new Map<string, string>();

  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return this.config.get<string>('HOSTINGER_MAIL_API_BASE') ?? 'https://api.mail.hostinger.com';
  }

  private token(): string {
    const token = this.config.get<string>('HOSTINGER_MAIL_API_TOKEN');
    if (!token) throw new Error('MAIL_API_TOKEN_MISSING');
    return token;
  }

  private async api(path: string, accept: string): Promise<Response> {
    const res = await fetch(this.base() + path, {
      headers: { Authorization: 'Bearer ' + this.token(), Accept: accept },
    });
    if (!res.ok) throw new Error('MAIL_API_HTTP_' + res.status);
    return res;
  }

  /** Resolve (and cache) the mailboxResourceId for an address via /me. */
  async resolveMailbox(address: string): Promise<string> {
    const key = address.toLowerCase();
    const cached = this.mailboxIds.get(key);
    if (cached) return cached;

    const res = await this.api('/api/v1/me', 'application/json');
    const body = await res.json();
    const hit = (body?.data?.mailboxes ?? []).find(
      (m: any) => String(m?.address ?? '').toLowerCase() === key,
    );
    if (!hit?.resourceId) throw new Error('MAILBOX_NOT_FOUND: ' + key);
    this.mailboxIds.set(key, hit.resourceId);
    return hit.resourceId;
  }

  async fetchMessage(resourceId: string, folder: string, uid: number): Promise<FetchedMessage> {
    const folderEnc = encodeURIComponent(folder);
    const prefix = '/api/v1/mailboxes/' + encodeURIComponent(resourceId) + '/folders/' + folderEnc + '/messages/' + uid;

    const raw = Buffer.from(await (await this.api(prefix + '/source', 'message/rfc822')).arrayBuffer());

    let from: string | null = null;
    let metadata: any = null;
    try {
      metadata = await (await this.api(prefix, 'application/json')).json();
      from = metadata?.data?.from?.address ?? metadata?.from?.address ?? null;
    } catch {
      // Metadata is best-effort; the source itself is what we archive.
      this.logger.warn('Mail metadata fetch failed for uid ' + uid + '; falling back to header parse');
    }

    if (!from) from = this.fromHeader(raw);
    this.logger.log('Fetched message uid ' + uid + ' (' + raw.length + ' bytes) from ' + (from ?? '<unknown>'));
    return { raw, from };
  }

  /** RFC822 From:-header fallback; case-insensitive address extraction. */
  private fromHeader(raw: Buffer): string | null {
    const header = raw.toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
    const m = header.match(/^From:\s*(.+)$/im);
    if (!m) return null;
    const addr = m[1].match(/[\w.+-]+@[\w.-]+/);
    return addr ? addr[0].toLowerCase() : null;
  }
}
