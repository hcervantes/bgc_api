import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type SessionRole = 'STAFF' | 'ADMIN' | 'CLIENT_ADMIN' | 'CLIENT_USER';

export interface SessionUser {
  sub: string;                   // portal user id
  role: SessionRole;
  clients: string[];             // client SLUGS the user belongs to (empty for staff)
  activeClientId: string | null; // active client slug; null for staff
}

export interface TenantContext {
  clientId: string; // resolved DB id (uuid)
  slug: string;
  status: 'active' | 'suspended' | 'cancelled';
}

// Type req.user / req.tenant across the app (kills `as any` casts)
declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
    tenant?: TenantContext;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as SessionUser;
  },
);
