import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ROLES_KEY } from './roles.decorator';
import { SessionRole, SessionUser } from './current-user.decorator';

export const Public = () => SetMetadata('isPublic', true);

/**
 * Verifies RS256 session JWTs issued by bgc-portal.
 * Enforces role gates (Roles decorator). No MFA enforcement this phase.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private jwt: JwtService;

  constructor(private reflector: Reflector) {
    const publicKey = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
    if (!publicKey) {
      throw new Error('JWT_PUBLIC_KEY is not set — cannot verify tokens. Aborting boot.');
    }
    this.jwt = new JwtService({
      publicKey,
      verifyOptions: {
        algorithms: ['RS256'],
        issuer: process.env.JWT_ISSUER ?? 'bgc-portal',
        audience: process.env.JWT_AUDIENCE ?? 'bgc-api',
      },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (this.reflector.getAllAndOverride<boolean>('isPublic', [context.getHandler(), context.getClass()])) {
      return true;
    }

    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    const user: SessionUser = {
      sub: payload.sub as string,
      role: payload.role as SessionRole,
      clients: Array.isArray(payload.clients) ? (payload.clients as string[]) : [],
      activeClientId: (payload.activeClientId as string) ?? null,
    };
    request.user = user;

    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !required.includes(user.role)) {
      throw new ForbiddenException();
    }

    return true;
  }
}
