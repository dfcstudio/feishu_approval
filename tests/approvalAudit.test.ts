import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { env, type AppEnv } from "../src/config/env.js";
import { ApprovalAuditService } from "../src/services/approval/ApprovalAuditService.js";

const testConfig: AppEnv = {
  ...env,
  NODE_ENV: "test",
  SAVE_ORIGINAL_FILE: true,
  APPROVAL_AMOUNT_FIELD_NAMES: ["报销金额"],
  APPROVAL_ATTACHMENT_FIELD_NAMES: ["付款凭证"],
  APPROVAL_APPLICANT_FIELD_NAMES: ["报销人"],
};
const storedEvidence = { id: "stored", documentType: "PAYMENT", ocrAmount: { toString: () => "10.00" }, riskLevel: "LOW", riskReasons: [], transactionId: null, paidAt: null, payee: null };

describe("ApprovalAuditService", () => {
  it("skips a duplicate APPROVED notification", async () => {
    const db = {
      approvalAuditRun: { findUnique: vi.fn().mockResolvedValue({ approvedNotifiedAt: new Date() }) },
      paymentEvidence: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const notifyService = { sendAuditResult: vi.fn() };
    const service = new ApprovalAuditService({
      db,
      config: testConfig,
      feishuClient: {} as never,
      storageProvider: {} as never,
      ocrProvider: {} as never,
      dedupeService: {} as never,
      notifyService: notifyService as never,
    });

    await expect(service.audit("inst_notified", true, "APPROVED")).resolves.toEqual({
      skipped: true,
      evidenceIds: [],
    });
    expect(db.paymentEvidence.findFirst).not.toHaveBeenCalled();
    expect(notifyService.sendAuditResult).not.toHaveBeenCalled();
  });

  it("seals an approved audit after notifying handlers even when an ancillary notification warns", async () => {
    const db = {
      approvalAuditRun: {
        findUnique: vi.fn().mockResolvedValue({ instanceCode: "inst_1", status: "SUCCESS" }),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentEvidence: {
        findFirst: vi.fn().mockResolvedValue({ id: "evidence_1", storageKey: null }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([storedEvidence]),
      },
      approvalAuditSummary: { upsert: vi.fn() },
    } as unknown as PrismaClient;

    const storageProvider = {
      save: vi.fn().mockResolvedValue({ storageKey: "2026-07-09/file.png", size: 4 }),
    };
    const ocrProvider = { recognizePaymentEvidence: vi.fn() };
    const dedupeService = { findAndPersistMatches: vi.fn() };
    const notifyService = {
      sendAuditResult: vi.fn(),
      sendManualReviewWarning: vi.fn(),
      sendOriginalFileSaved: vi.fn().mockRejectedValue(new Error("saved notice failed")),
    };

    const service = new ApprovalAuditService({
      db,
      config: testConfig,
      feishuClient: {
        getApprovalInstanceDetail: vi.fn().mockResolvedValue({
          instanceCode: "inst_1",
          form: [
            { name: "报销金额", value: "10.00" },
            { name: "付款凭证", value: [{ file_token: "file_1", name: "pay.png", mime_type: "image/png" }] },
            { name: "办理人", value: [{ open_id: "ou_handler" }] },
          ],
          raw: {},
        }),
        downloadApprovalFile: vi.fn().mockResolvedValue(Buffer.from("file")),
      } as never,
      imageHashService: { perceptualHash: vi.fn().mockResolvedValue("phash") } as never,
      storageProvider: storageProvider as never,
      ocrProvider: ocrProvider as never,
      dedupeService: dedupeService as never,
      notifyService: notifyService as never,
    });

    const result = await service.audit("inst_1", true, "APPROVED");

    expect(result).toEqual({
      skipped: false,
      evidenceIds: ["evidence_1"],
      warning: "Notification failed: saved notice failed",
    });
    expect(storageProvider.save).toHaveBeenCalledOnce();
    expect(db.paymentEvidence.create).not.toHaveBeenCalled();
    expect(ocrProvider.recognizePaymentEvidence).not.toHaveBeenCalled();
    expect(dedupeService.findAndPersistMatches).not.toHaveBeenCalled();
    expect(notifyService.sendAuditResult).toHaveBeenCalledOnce();
    expect(notifyService.sendAuditResult).toHaveBeenCalledWith(expect.objectContaining({
      notificationKey: "audit-approved:inst_1",
      notificationStage: "APPROVED_HANDOFF",
      applicantId: undefined,
      currentApprovers: [],
      extraRecipientOpenIds: ["ou_handler"],
      documentSummary: expect.objectContaining({ paymentDocumentCount: 1 }),
    }));
    expect(notifyService.sendOriginalFileSaved).toHaveBeenCalledWith({
      serialNumber: undefined,
      instanceCode: "inst_1",
      fileName: "pay.png",
      storageKey: "2026-07-09/file.png",
    });
    expect(db.paymentEvidence.update).toHaveBeenCalledWith({
      where: { id: "evidence_1" },
      data: expect.objectContaining({
        storageKey: "2026-07-09/file.png",
        perceptualHash: "phash",
      }),
    });
    expect(db.approvalAuditRun.update).toHaveBeenLastCalledWith({
      where: { instanceCode: "inst_1" },
      data: expect.objectContaining({
        status: "SUCCESS_WITH_WARNING",
        approvedNotifiedAt: expect.any(Date),
      }),
    });
  });

  it("keeps a successful audit when result notification fails", async () => {
    const db = {
      approvalAuditRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentEvidence: {
        create: vi.fn().mockResolvedValue({ id: "evidence_2" }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([storedEvidence]),
      },
      approvalAuditSummary: { upsert: vi.fn() },
    } as unknown as PrismaClient;

    const notifyService = {
      sendAuditResult: vi.fn().mockRejectedValue(new Error("message API unavailable")),
      sendManualReviewWarning: vi.fn(),
      sendOriginalFileSaved: vi.fn(),
    };

    const service = new ApprovalAuditService({
      db,
      config: testConfig,
      feishuClient: {
        getApprovalInstanceDetail: vi.fn().mockResolvedValue({
          instanceCode: "inst_2",
          form: [
            { name: "报销金额", value: "10.00" },
            { name: "付款凭证", value: [{ file_token: "file_2", name: "pay.png", mime_type: "image/png" }] },
          ],
          raw: {},
        }),
        downloadApprovalFile: vi.fn().mockResolvedValue(Buffer.from("file")),
      } as never,
      hashService: { sha256: vi.fn().mockReturnValue("sha256") } as never,
      imageHashService: { perceptualHash: vi.fn().mockResolvedValue("phash") } as never,
      storageProvider: { save: vi.fn() } as never,
      ocrProvider: {
        recognizePaymentEvidence: vi.fn().mockResolvedValue({
          rawText: "支付金额：10.00",
          amount: "10.00",
          confidence: 0.9,
        }),
      } as never,
      dedupeService: { findAndPersistMatches: vi.fn().mockResolvedValue([]) } as never,
      notifyService: notifyService as never,
    });

    const result = await service.audit("inst_2", false);

    expect(result.warning).toContain("Notification failed: message API unavailable");
    expect(db.approvalAuditRun.update).toHaveBeenLastCalledWith({
      where: { instanceCode: "inst_2" },
      data: expect.objectContaining({
        status: "SUCCESS_WITH_WARNING",
        errorMessage: "Notification failed: message API unavailable",
      }),
    });
  });

  it("uses APPLICANT_NAME_MAP when approval details only contain an applicant id", async () => {
    const db = {
      approvalAuditRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentEvidence: {
        create: vi.fn().mockResolvedValue({ id: "evidence_4" }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([storedEvidence]),
      },
      approvalAuditSummary: { upsert: vi.fn() },
    } as unknown as PrismaClient;

    const notifyService = {
      sendAuditResult: vi.fn(),
      sendManualReviewWarning: vi.fn(),
      sendOriginalFileSaved: vi.fn(),
    };

    const service = new ApprovalAuditService({
      db,
      config: { ...testConfig, APPLICANT_NAME_MAP: { "42cg4661": "张三" } },
      feishuClient: {
        getApprovalInstanceDetail: vi.fn().mockResolvedValue({
          instanceCode: "inst_4",
          applicantId: "42cg4661",
          applicantName: "42cg4661",
          form: [
            { name: "报销金额", value: "10.00" },
            { name: "付款凭证", value: [{ file_token: "file_4", name: "pay.png", mime_type: "image/png" }] },
            { name: "报销人", value: "7b8afdbb" },
          ],
          raw: {},
        }),
        downloadApprovalFile: vi.fn().mockResolvedValue(Buffer.from("file")),
        resolveUserName: vi.fn(),
      } as never,
      hashService: { sha256: vi.fn().mockReturnValue("sha256") } as never,
      imageHashService: { perceptualHash: vi.fn().mockResolvedValue("phash") } as never,
      storageProvider: { save: vi.fn() } as never,
      ocrProvider: {
        recognizePaymentEvidence: vi.fn().mockResolvedValue({
          rawText: "支付金额：10.00",
          amount: "10.00",
          confidence: 0.9,
        }),
      } as never,
      dedupeService: { findAndPersistMatches: vi.fn().mockResolvedValue([]) } as never,
      notifyService: notifyService as never,
    });

    await service.audit("inst_4", false);

    expect(db.paymentEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicantId: "42cg4661",
        applicantName: "张三",
      }),
      select: { id: true },
    });
    expect(notifyService.sendAuditResult).toHaveBeenCalledWith(expect.objectContaining({ applicantName: "张三" }));
  });

  it("reuses existing evidence when concurrent creation hits a unique constraint", async () => {
    const db = {
      approvalAuditRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentEvidence: {
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
        findFirst: vi.fn().mockResolvedValue({ id: "existing_evidence" }),
        update: vi.fn(),
        findMany: vi.fn().mockResolvedValue([storedEvidence]),
      },
      approvalAuditSummary: { upsert: vi.fn() },
    } as unknown as PrismaClient;

    const dedupeService = { findAndPersistMatches: vi.fn() };
    const notifyService = {
      sendAuditResult: vi.fn(),
      sendManualReviewWarning: vi.fn(),
      sendOriginalFileSaved: vi.fn(),
    };

    const service = new ApprovalAuditService({
      db,
      config: testConfig,
      feishuClient: {
        getApprovalInstanceDetail: vi.fn().mockResolvedValue({
          instanceCode: "inst_3",
          form: [
            { name: "报销金额", value: "10.00" },
            { name: "付款凭证", value: [{ file_token: "file_3", name: "pay.png", mime_type: "image/png" }] },
          ],
          raw: {},
        }),
        downloadApprovalFile: vi.fn().mockResolvedValue(Buffer.from("file")),
      } as never,
      hashService: { sha256: vi.fn().mockReturnValue("sha256") } as never,
      imageHashService: { perceptualHash: vi.fn().mockResolvedValue("phash") } as never,
      storageProvider: { save: vi.fn() } as never,
      ocrProvider: {
        recognizePaymentEvidence: vi.fn().mockResolvedValue({
          rawText: "支付金额：10.00",
          amount: "10.00",
          confidence: 0.9,
        }),
      } as never,
      dedupeService: dedupeService as never,
      notifyService: notifyService as never,
    });

    const result = await service.audit("inst_3", false);

    expect(result).toEqual({ skipped: false, evidenceIds: ["existing_evidence"] });
    expect(dedupeService.findAndPersistMatches).not.toHaveBeenCalled();
    expect(notifyService.sendAuditResult).toHaveBeenCalledOnce();
  });
});
