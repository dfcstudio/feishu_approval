-- CreateEnum
CREATE TYPE "AuditRunStatus" AS ENUM ('PROCESSING', 'SUCCESS', 'SUCCESS_WITH_WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DuplicateMatchType" AS ENUM ('SHA256', 'PERCEPTUAL_HASH', 'TRANSACTION_ID', 'COMPOSITE');

-- CreateTable
CREATE TABLE "approval_audit_runs" (
    "id" TEXT NOT NULL,
    "instanceCode" TEXT NOT NULL,
    "status" "AuditRunStatus" NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_evidences" (
    "id" TEXT NOT NULL,
    "instanceCode" TEXT NOT NULL,
    "applicantId" TEXT,
    "applicantName" TEXT,
    "approvalName" TEXT,
    "approvalAmount" DECIMAL(18,2) NOT NULL,
    "ocrAmount" DECIMAL(18,2),
    "amountMatched" BOOLEAN NOT NULL,
    "transactionId" TEXT,
    "paidAt" TIMESTAMP(3),
    "payee" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "storageKey" TEXT,
    "sha256" TEXT NOT NULL,
    "perceptualHash" TEXT,
    "ocrRawText" TEXT,
    "ocrConfidence" DOUBLE PRECISION NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "riskReasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_matches" (
    "id" TEXT NOT NULL,
    "currentEvidenceId" TEXT NOT NULL,
    "matchedEvidenceId" TEXT NOT NULL,
    "matchType" "DuplicateMatchType" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_audit_runs_instanceCode_key" ON "approval_audit_runs"("instanceCode");

-- CreateIndex
CREATE INDEX "payment_evidences_instanceCode_idx" ON "payment_evidences"("instanceCode");

-- CreateIndex
CREATE UNIQUE INDEX "payment_evidences_instanceCode_sha256_key" ON "payment_evidences"("instanceCode", "sha256");

-- CreateIndex
CREATE INDEX "payment_evidences_sha256_idx" ON "payment_evidences"("sha256");

-- CreateIndex
CREATE INDEX "payment_evidences_transactionId_idx" ON "payment_evidences"("transactionId");

-- CreateIndex
CREATE INDEX "payment_evidences_approvalAmount_paidAt_payee_idx" ON "payment_evidences"("approvalAmount", "paidAt", "payee");

-- CreateIndex
CREATE INDEX "duplicate_matches_currentEvidenceId_idx" ON "duplicate_matches"("currentEvidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_matches_currentEvidenceId_matchedEvidenceId_matchType_key" ON "duplicate_matches"("currentEvidenceId", "matchedEvidenceId", "matchType");

-- CreateIndex
CREATE INDEX "duplicate_matches_matchedEvidenceId_idx" ON "duplicate_matches"("matchedEvidenceId");

-- AddForeignKey
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_currentEvidenceId_fkey" FOREIGN KEY ("currentEvidenceId") REFERENCES "payment_evidences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_matches" ADD CONSTRAINT "duplicate_matches_matchedEvidenceId_fkey" FOREIGN KEY ("matchedEvidenceId") REFERENCES "payment_evidences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
