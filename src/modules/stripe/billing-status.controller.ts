import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, SessionUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

// GET /v1/billing/status — called by the portal with the user's session
// JWT. Subscription state is owned by bgc-api (written only by the Stripe
// webhook); the portal reads it here instead of its own DB.
//
// Keyed by portalUserId (= JWT sub), which the webhook stores from
// subscription metadata set at portal checkout. findFirst on updatedAt
// keeps this correct even if a user ever has more than one subscription
// row (e.g. after a cancel + resubscribe cycle).
@Controller('billing/status')
// JwtAuthGuard is per-controller in this codebase (not global) — without
// it, unauthenticated requests reach the handler with req.user undefined.
@UseGuards(JwtAuthGuard)
export class BillingStatusController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async status(@CurrentUser() user: SessionUser) {
    const sub = await this.prisma.stripeSubscription.findFirst({
      where: { portalUserId: user.sub },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      status: sub?.status ?? null,
      priceId: sub?.priceId ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
    };
  }
}
