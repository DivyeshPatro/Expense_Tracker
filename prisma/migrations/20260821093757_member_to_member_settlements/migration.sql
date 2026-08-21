-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "fromParticipantId" TEXT,
ADD COLUMN     "toParticipantId" TEXT,
ALTER COLUMN "participantId" DROP NOT NULL,
ALTER COLUMN "direction" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_fromParticipantId_fkey" FOREIGN KEY ("fromParticipantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_toParticipantId_fkey" FOREIGN KEY ("toParticipantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
