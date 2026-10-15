import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth/jwt-auth.guard';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
