import { CanActivate, ExecutionContext, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionUser } from '../auth/current-user.decorator';

/**
 * Iron rule: the clientId on a request is NEVER trusted as-is — it is
 * resolved against the Client table, and access is granted only when:
 * - client roles (CLIENT_ADMIN / CLIENT_USER): clientId is in session.clients; else 404 (anti-enumeration)
 * - staff (STAFF / ADMIN): any clientId allowed
 * - suspended client: mutations rejected 409; reads pass
 * - cancelled client: everything 404
 *
 * clientId in URLs is a client SLUG (e.g. "company-a").
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as SessionUser;

    const clientId: string | undefined =
      request.params?.clientId ?? request.body?.clientId ?? request.query?.clientId;

    if (!clientId) throw new NotFoundException(); // tenant context required

    // session.clients is an array of client slugs
    const isMember = (user.clients ?? []).some((c) => c === clientId);
    const isStaff = user.role === 'STAFF' || user.role === 'ADMIN';
    if (!isStaff && !isMember) throw new NotFoundException(); // never 403

    const client = await this.prisma.client.findUnique({ where: { slug: clientId } });
    if (!client || client.status === 'cancelled') throw new NotFoundException();

    if (client.status === 'suspended' && request.method !== 'GET') {
      throw new ConflictException('CLIENT_SUSPENDED');
    }

    request.tenant = { clientId: client.id, slug: client.slug, status: client.status };
    return true;
  }
}
