-- CreateEnum
CREATE TYPE "CardNetwork" AS ENUM ('VISA', 'MASTERCARD', 'RUPAY', 'AMEX', 'DINERS', 'OTHER');

-- CreateTable
CREATE TABLE "CreditCard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "network" "CardNetwork" NOT NULL,
    "last4" TEXT NOT NULL,
    "color" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "numberCipher" BYTEA NOT NULL,
    "numberIv" BYTEA NOT NULL,
    "holderCipher" BYTEA NOT NULL,
    "holderIv" BYTEA NOT NULL,
    "expiryCipher" BYTEA NOT NULL,
    "expiryIv" BYTEA NOT NULL,
    "cvvCipher" BYTEA NOT NULL,
    "cvvIv" BYTEA NOT NULL,
    "notesCipher" BYTEA,
    "notesIv" BYTEA,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "keyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditCard_userId_idx" ON "CreditCard"("userId");

-- AddForeignKey
ALTER TABLE "CreditCard" ADD CONSTRAINT "CreditCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
