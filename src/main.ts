import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('v1');
  app.use(helmet());
  // Behind nginx/DO load balancer in staging+prod: trust one proxy hop.
  if (config.get('NODE_ENV') !== 'development') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();

  await app.listen(config.get('PORT') ?? 4000);
  console.log(`BGC API listening on :${config.get('PORT') ?? 4000}/v1`);
}
bootstrap();
