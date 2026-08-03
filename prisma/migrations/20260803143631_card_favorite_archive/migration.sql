-- AlterTable
ALTER TABLE "CreditCard" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isFavorite" BOOLEAN NOT NULL DEFAULT false;
