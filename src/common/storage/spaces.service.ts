import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

@Injectable()
export class SpacesService {
  private readonly logger = new Logger(SpacesService.name);
  private client?: S3Client;

  constructor(private readonly config: ConfigService) {}

  /** Lazily built so the app can boot without Spaces creds (e.g. tests). */
  private s3(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.requireEnv('DO_SPACES_ENDPOINT'),
        region: this.requireEnv('DO_SPACES_REGION'),
        forcePathStyle: false,
        credentials: {
          accessKeyId: this.requireEnv('DO_SPACES_KEY'),
          secretAccessKey: this.requireEnv('DO_SPACES_SECRET'),
        },
      });
    }
    return this.client;
  }

  private requireEnv(name: string): string {
    const v = this.config.get<string>(name);
    if (!v) throw new Error('SPACES_NOT_CONFIGURED: ' + name + ' missing');
    return v;
  }

  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3().send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
    this.logger.log('Spaces PUT ok: s3://' + bucket + '/' + key + ' (' + body.length + ' bytes)');
  }
}
