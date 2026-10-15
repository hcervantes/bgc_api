# BGC API — Getting Started

## 1. Configure

    cp .env.example .env

Fill in: JWT_PUBLIC_KEY (portal's public key), ENCRYPTION_KEY (openssl rand -hex 32),
SEED_CLIENT_ADMIN_USER_ID (= portal user id that appears in JWT sub),
ERPNEXT_SEED_API_KEY / _API_SECRET (from bgc-dev.localhost ERPNext user).

## 2. Start infra + migrate + seed

    docker compose up -d
    npx prisma migrate dev --name init
    npm run seed

## 3. Run + verify

    npm run dev
    curl http://localhost:4000/v1/health

then, with a portal-issued token:

    curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/clients/company-a/erpnext-link/health

## Conventions (locked in)

- JWT: RS256, issuer bgc-portal, audience bgc-api; claims: sub, role, clients (slugs), activeClientId
- Roles are UPPERCASE strings everywhere (JWT, guards, decorators, Prisma enums)
- URL tenant identifier is the client SLUG; internally resolved to uuid by TenantGuard
- ERPNext connection info lives ONLY in ErpNextSite (sealed with AES-256-GCM)
- Anti-enumeration: unauthorized/wrong tenant returns 404, never 403
