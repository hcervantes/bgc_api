/*
  Warnings:

  - A unique constraint covering the columns `[clientId]` on the table `StripeSubscription` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "erpCompanyName" TEXT;

-- AlterTable
ALTER TABLE "StripeSubscription" ADD COLUMN     "clientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StripeSubscription_clientId_key" ON "StripeSubscription"("clientId");

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
