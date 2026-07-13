import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../../config/env.js";
import type { ApprovalAuditService } from "../approval/ApprovalAuditService.js";

export class ApprovalAuditJobService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly workerId = randomUUID();
  constructor(private readonly db: PrismaClient, private readonly processor: ApprovalAuditService,
    private readonly config: Pick<AppEnv, "AUDIT_WORKER_POLL_MS" | "AUDIT_JOB_LEASE_SECONDS" | "AUDIT_JOB_MAX_RETRIES">) {}

  async audit(instanceCode: string, saveFiles = true, status?: string): Promise<{ queued: boolean }> {
    const existing = await this.db.approvalAuditRun.findUnique({ where: { instanceCode } });
    const isApprovedUpgrade = status?.toUpperCase() === "APPROVED" && !existing?.approvedNotifiedAt;
    if (existing && ["QUEUED", "PROCESSING"].includes(existing.status)) return { queued: false };
    if (existing && ["SUCCESS", "SUCCESS_WITH_WARNING"].includes(existing.status) && !isApprovedUpgrade) return { queued: false };
    await this.db.approvalAuditRun.upsert({ where: { instanceCode },
      create: { instanceCode, status: "QUEUED", saveFiles, requestedStatus: status },
      update: { status: "QUEUED", saveFiles, requestedStatus: status, nextRetryAt: new Date(), leaseUntil: null, leaseOwner: null, errorMessage: null } });
    return { queued: true };
  }

  start(): void { if (this.timer) return; const tick = () => void this.processNext().finally(() => { this.timer = setTimeout(tick, this.config.AUDIT_WORKER_POLL_MS); this.timer.unref(); }); tick(); }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  async processNext(): Promise<boolean> {
    if (this.running) return false; this.running = true;
    try {
      const job = await this.claimNext(); if (!job) return false;
      try { await this.processor.audit(job.instanceCode, job.saveFiles, job.requestedStatus ?? undefined); }
      catch (error) {
        const retryCount = job.retryCount + 1; const exhausted = retryCount >= this.config.AUDIT_JOB_MAX_RETRIES;
        await this.db.approvalAuditRun.updateMany({ where: { id: job.id, leaseOwner: this.workerId }, data: {
          status: exhausted ? "FAILED" : "QUEUED", retryCount,
          nextRetryAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** retryCount)), leaseUntil: null, leaseOwner: null,
          finishedAt: exhausted ? new Date() : null, errorMessage: error instanceof Error ? error.message : String(error),
        } });
      }
      return true;
    } finally { this.running = false; }
  }
  private async claimNext() {
    const now = new Date();
    const candidate = await this.db.approvalAuditRun.findFirst({ where: { OR: [
      { status: "QUEUED", nextRetryAt: { lte: now } }, { status: "PROCESSING", leaseUntil: { lt: now } },
    ] }, orderBy: { nextRetryAt: "asc" } });
    if (!candidate) return null;
    const claimed = await this.db.approvalAuditRun.updateMany({ where: { id: candidate.id, OR: [
      { status: "QUEUED", nextRetryAt: { lte: now } }, { status: "PROCESSING", leaseUntil: { lt: now } },
    ] }, data: { status: "PROCESSING", leaseUntil: new Date(Date.now() + this.config.AUDIT_JOB_LEASE_SECONDS * 1000), leaseOwner: this.workerId, startedAt: now } });
    return claimed.count === 1 ? candidate : null;
  }
}
