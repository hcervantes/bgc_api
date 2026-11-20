import { Module } from '@nestjs/common';
import { SpacesService } from './spaces.service';

// Shared S3-compatible client for DigitalOcean Spaces (@aws-sdk/client-s3,
// already a dependency). Consumed by mail intake staging now and the
// documents presign flow next.
@Module({
  providers: [SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
