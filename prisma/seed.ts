import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import { encryptSecret } from '../src/modules/erpnext/credentials.crypto';

const prisma = new PrismaClient();

/** Fail fast on missing config — never silently seed "undefined" secrets. */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Aborting seed.`);
  }
  return value;
}

async function main() {
  // --- Portal user mirror (id = JWT sub) -----------------------------
  // Keyed by id (the value that must match the portal), not email.
  const clientAdminId = requiredEnv('SEED_CLIENT_ADMIN_USER_ID');
  const clientUser = await prisma.user.upsert({
    where: { id: clientAdminId },
    update: {},
    create: {
      id: clientAdminId,
      email: process.env.SEED_CLIENT_ADMIN_EMAIL ?? 'clienta-admin@bgcdev.local',
      name: 'Client A Admin',
      role: Role.CLIENT_ADMIN,
    },
  });

  // Optional staff mirror — only seeds when a real portal staff user exists.
  const staffId = process.env.SEED_STAFF_USER_ID;
  if (staffId) {
    await prisma.user.upsert({
      where: { id: staffId },
      update: {},
      create: {
        id: staffId,
        email: 'staff@bgcdev.local',
        name: 'BGC Staff',
        role: Role.STAFF,
      },
    });
  }

  // --- Tenants ----------------------------------------------------------
  const clientA = await prisma.client.upsert({
    where: { slug: 'company-a' },
    update: {},
    create: {
      slug: 'company-a',
      name: 'Company A',
      legalName: 'Company A LLC',
      email: 'a@example.com',
      status: 'active',
      bookkeepingEnabled: true,
    },
  });

  const clientB = await prisma.client.upsert({
    where: { slug: 'company-b' },
    update: {},
    create: {
      slug: 'company-b',
      name: 'Company B',
      legalName: 'Company B Inc',
      email: 'b@example.com',
      status: 'active',
      bookkeepingEnabled: true,
      // No ErpNextSite row: Company B is unprovisioned — a deliberate
      // negative test case (its health endpoint should fail cleanly).
    },
  });

  // --- ERPNext site for Company A (dev: bgc-dev.localhost) --------------
  await prisma.erpNextSite.upsert({
    where: { clientId: clientA.id },
    update: {},
    create: {
      clientId: clientA.id,
      siteName: 'bgc-dev',
      siteUrl: requiredEnv('ERPNEXT_SEED_SITE_URL'),
      companyName: 'Company A LLC',
      apiUser: process.env.ERPNEXT_SEED_API_USER ?? null,
      apiKeyEncrypted: encryptSecret(requiredEnv('ERPNEXT_SEED_API_KEY')),
      apiSecretEncrypted: encryptSecret(requiredEnv('ERPNEXT_SEED_API_SECRET')),
    },
  });

  // --- Membership --------------------------------------------------------
  await prisma.clientUser.upsert({
    where: { clientId_userId: { clientId: clientA.id, userId: clientUser.id } },
    update: {},
    create: { clientId: clientA.id, userId: clientUser.id, isPrimaryContact: true },
  });

  console.log('Seeded:', {
    users: [clientUser.email, ...(staffId ? ['staff@bgcdev.local'] : [])],
    clients: [clientA.slug, clientB.slug],
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
