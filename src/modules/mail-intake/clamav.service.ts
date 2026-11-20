import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import net from 'net';

export interface ScanResult {
  ok: boolean;
  /** Virus name when not ok (clamd FOUND line). */
  signature?: string;
}

// Minimal clamd INSTREAM client — no extra dependency. The compose stack
// already runs a ClamAV container (CLAMD_HOST); prod droplet fix verified
// Oct 2026. Fails closed: a clamd outage surfaces as an error so the caller
// can treat the message as unscanned (transient failure -> Hostinger retry).
@Injectable()
export class ClamAvService {
  private readonly logger = new Logger(ClamAvService.name);

  constructor(private readonly config: ConfigService) {}

  async scan(buffer: Buffer): Promise<ScanResult> {
    const host = this.config.get<string>('CLAMD_HOST') ?? 'localhost';
    const port = Number(this.config.get<string>('CLAMD_PORT') ?? 3310);

    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(15_000);
      let response = '';

      socket.on('connect', () => {
        socket.write('zINSTREAM\u0000'); // INSTREAM is fine too; z-prefix is idempotent-safe here
        const CHUNK = 32 * 1024;
        for (let i = 0; i < buffer.length; i += CHUNK) {
          const chunk = buffer.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32LE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.from([0, 0, 0, 0])); // zero-length = EOF
      });

      socket.on('data', (d) => {
        response += d.toString('utf8');
      });
      socket.on('end', () => {
        const clean = response.trim().endsWith('OK');
        if (clean) resolve({ ok: true });
        else {
          const sig = response.trim().split('FOUND')[0].trim();
          this.logger.warn('ClamAV FOUND: ' + sig);
          resolve({ ok: false, signature: sig });
        }
      });
      socket.on('error', (err) => reject(new Error('CLAMD_UNREACHABLE: ' + err.message)));
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('CLAMD_TIMEOUT'));
      });
    });
  }
}
