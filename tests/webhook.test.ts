import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { env, type AppEnv } from "../src/config/env.js";
import { ApprovalAuditService } from "../src/services/approval/ApprovalAuditService.js";
import { handleFeishuApprovalWebhook } from "../src/routes/feishuWebhook.js";

const testConfig: AppEnv = {
  ...env,
  NODE_ENV: "test",
  FEISHU_VERIFICATION_TOKEN: "verify_token",
  FEISHU_ENCRYPT_KEY: "",
};

const testLogger = pino({ enabled: false });

describe("Feishu webhook", () => {
  it("responds to URL verification challenge", async () => {
    const response = await handleFeishuApprovalWebhook(
      {
        type: "url_verification",
        token: "verify_token",
        challenge: "challenge_value",
      },
      {
        config: testConfig,
        auditService: { audit: vi.fn() },
        logger: testLogger,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ challenge: "challenge_value" });
  });

  it("returns skipped when audit run has already succeeded", async () => {
    const db = {
      approvalAuditRun: {
        findUnique: vi.fn().mockResolvedValue({ instanceCode: "inst_1", status: "SUCCESS" }),
      },
    } as unknown as PrismaClient;

    const service = new ApprovalAuditService({
      db,
      config: testConfig,
      feishuClient: {
        getApprovalInstanceDetail: vi.fn(),
        downloadApprovalFile: vi.fn(),
      } as never,
      ocrProvider: {} as never,
      storageProvider: {} as never,
      dedupeService: {} as never,
      notifyService: {} as never,
    });

    const response = await handleFeishuApprovalWebhook(
      {
        token: "verify_token",
        header: { event_type: "approval_instance_status_changed", token: "verify_token" },
        event: { instance_code: "inst_1", status: "PENDING" },
      },
      {
        config: testConfig,
        auditService: service,
        logger: testLogger,
      },
    );

    expect(response.status).toBe(200);
    expect((response.body as { result: { skipped: boolean } }).result.skipped).toBe(true);
    expect(db.approvalAuditRun.findUnique).toHaveBeenCalledWith({ where: { instanceCode: "inst_1" } });
  });
});
