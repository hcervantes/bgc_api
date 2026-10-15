import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { CurrentUser, SessionUser } from '../../common/auth/current-user.decorator';

@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  /** The portal issues JWTs; the API only verifies. Frontend uses this to
   *  confirm session validity and read claims. */
  @Get('session')
  session(@CurrentUser() user: SessionUser) {
    return {
      userId: user.sub,
      role: user.role,
      clients: user.clients,
      activeClientId: user.activeClientId,
    };
  }
}
