ALTER TYPE "AuditRunStatus" ADD VALUE IF NOT EXISTS 'QUEUED' BEFORE 'PROCESSING';

ALTER TABLE "approval_audit_runs"
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "requestedStatus" TEXT,
  ADD COLUMN "saveFiles" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "approval_audit_runs_status_nextRetryAt_idx" ON "approval_audit_runs"("status", "nextRetryAt");
CREATE INDEX "approval_audit_runs_status_leaseUntil_idx" ON "approval_audit_runs"("status", "leaseUntil");

ALTER TABLE "payment_evidences"
  ADD COLUMN "fileToken" TEXT,
  ADD COLUMN "documentType" TEXT NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'COMPLETE';
CREATE UNIQUE INDEX "payment_evidences_instanceCode_fileToken_key" ON "payment_evidences"("instanceCode", "fileToken");

CREATE TABLE "approval_audit_summaries" (
  "id" TEXT NOT NULL, "instanceCode" TEXT NOT NULL, "expenseSummaryAmount" DECIMAL(18,2) NOT NULL,
  "paymentDocumentCount" INTEGER NOT NULL DEFAULT 0, "paymentRecognizedCount" INTEGER NOT NULL DEFAULT 0,
  "paymentTotal" DECIMAL(18,2), "paymentTotalMatched" BOOLEAN,
  "invoiceDocumentCount" INTEGER NOT NULL DEFAULT 0, "invoiceRecognizedCount" INTEGER NOT NULL DEFAULT 0,
  "invoiceTotal" DECIMAL(18,2), "invoiceTotalMatched" BOOLEAN, "riskLevel" "RiskLevel" NOT NULL,
  "riskReasons" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "approval_audit_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "approval_audit_summaries_instanceCode_key" ON "approval_audit_summaries"("instanceCode");

CREATE TABLE "notification_outbox" (
  "id" TEXT NOT NULL, "kind" TEXT NOT NULL, "dedupeKey" TEXT NOT NULL, "recipientRole" TEXT,
  "receiveIdType" TEXT NOT NULL, "receiveId" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3), CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_outbox_dedupeKey_key" ON "notification_outbox"("dedupeKey");
CREATE INDEX "notification_outbox_status_nextRetryAt_idx" ON "notification_outbox"("status", "nextRetryAt");

CREATE TABLE "notification_rules" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "departmentId" TEXT, "minRiskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW', "recipientRole" TEXT NOT NULL,
  "receiveIdType" TEXT, "receiveId" TEXT, "notifyApplicant" BOOLEAN NOT NULL DEFAULT false,
  "notifyCurrentApprovers" BOOLEAN NOT NULL DEFAULT false, "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_rules_enabled_departmentId_minRiskLevel_idx" ON "notification_rules"("enabled", "departmentId", "minRiskLevel");

CREATE TABLE "department_notification_owners" (
  "id" TEXT NOT NULL, "departmentId" TEXT NOT NULL, "role" TEXT NOT NULL, "receiveIdType" TEXT NOT NULL,
  "receiveId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "department_notification_owners_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "department_notification_owners_departmentId_role_receiveIdType_receiveId_key" ON "department_notification_owners"("departmentId", "role", "receiveIdType", "receiveId");
CREATE INDEX "department_notification_owners_departmentId_role_idx" ON "department_notification_owners"("departmentId", "role");
