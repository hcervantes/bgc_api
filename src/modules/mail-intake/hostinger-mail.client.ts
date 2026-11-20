import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FetchedMessage {
  /** Raw message bytes (.eml) as returned by the Mail API. */
  raw: Buffer;
  /** Sender address extracted from the envelope or From: header. */
  from: string | null;
}

// Minimal Hostinger Mail API client for the intake worker. The real endpoint
// shape is being verified against Hostinger's docs; base URL and path
// template are env-overridable so corrections are config, not code.
@Injectable()
export class HostingerMailClient {
  private readonly logger = new Logger(HostingerMailClient.name);

  constructor(private readonly config: ConfigService) {}

  async fetchMessage(messageId: string): Promise<FetchedMessage> {
    const token = this.config.get<string>('HOSTINGER_MAIL_API_TOKEN');
    if (!token) throw new Error('MAIL_API_TOKEN_MISSING');

    const base = this.config.get<string>('HOSTINGER_MAIL_API_BASE') ?? 'https://api.mail.hostinger.com';
    const template =
      this.config.get<string>('HOSTINGER_MAIL_API_PATH_TEMPLATE') ?? '/v1/messages/{id}';
    const url = base + template.replace('{id}', encodeURIComponent(messageId));

    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, message/rfc822' },
    });
    if (!res.ok) {
      throw new Error('MAIL_API_HTTP_' + res.status);
    }
    const raw = Buffer.from(await res.arrayBuffer());
    this.logger.log('Fetched mail message ' + messageId + ' (' + raw.length + ' bytes)');
    return { raw, from: this.extractFrom(raw) };
  }

  /**
   * Fallback From extraction from the raw .eml header — tolerant of the
   * Mail API returning either a JSON envelope or raw RFC-822. The exact
   * envelope shape will be tightened once verified against live payloads.
   */
  private extractFrom(raw: Buffer): string | null {
    try {
      const asText = raw.toString('utf8');
      const maybeJson = JSON.parse(asText);
      const from =
        maybeJson?.from?.address ?? maybeJson?.from ?? maybeJson?.data?.from?.address ?? null;
      if (typeof from === 'string') return from.toLowerCase();
    } catch {
      // not JSON — parse the RFC-822 From: header
    }
    const header = raw.toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
    const m = header.match(/^From:\s*(.+)$/im);
    if (!m) return null;
    const addr = m[1].match(/[\w.+-]+@[\w.-]+/);
    return addr ? addr[0].toLowerCase() : null;
  }
}
