import { Router } from "express";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import { AppError, toErrorMessage } from "../utils/errors.js";
import type { ApprovalAuditService } from "../services/approval/ApprovalAuditService.js";
import {
  ensureNotEncrypted,
  extractApprovalEvent,
  isUrlVerification,
  parseFeishuWebhookPayload,
  shouldAuditApprovalStatus,
  verifyEventToken,
} from "../services/feishu/verifyFeishuEvent.js";

export interface AuditServiceLike {
  audit(instanceCode: string, saveFiles: boolean): Promise<unknown>;
}

export interface FeishuWebhookDeps {
  auditService: ApprovalAuditService | AuditServiceLike;
  config: Pick<AppEnv, "FEISHU_VERIFICATION_TOKEN" | "FEISHU_ENCRYPT_KEY">;
  logger: Logger;
}

export interface FeishuWebhookResponse {
  status: number;
  body: unknown;
}

export const handleFeishuApprovalWebhook = async (
  body: unknown,
  deps: FeishuWebhookDeps,
): Promise<FeishuWebhookResponse> => {
  try {
    const payload = parseFeishuWebhookPayload(body);
    ensureNotEncrypted(payload, deps.config.FEISHU_ENCRYPT_KEY);
    verifyEventToken(payload, deps.config.FEISHU_VERIFICATION_TOKEN);

    if (isUrlVerification(payload)) {
      return { status: 200, body: { challenge: payload.challenge } };
    }

    const event = extractApprovalEvent(payload);
    if (!event) {
      deps.logger.info({ eventType: payload.header?.event_type ?? payload.type }, "Ignored non approval event");
      return { status: 200, body: { ok: true, ignored: true } };
    }

    if (!shouldAuditApprovalStatus(event.status)) {
      deps.logger.info(
        { instanceCode: event.instanceCode, status: event.status },
        "Ignored terminal approval status",
      );
      return { status: 200, body: { ok: true, ignored: true } };
    }

    const saveFiles = event.status?.toUpperCase() === "APPROVED";
    const result = await deps.auditService.audit(event.instanceCode, saveFiles);
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      deps.logger.warn({ errorCode: error.errorCode }, "Rejected Feishu webhook");
      return { status: 401, body: { ok: false, errorCode: error.errorCode } };
    }

    deps.logger.error(
      {
        error: toErrorMessage(error),
        errorCode: error instanceof AppError ? error.errorCode : "WEBHOOK_PROCESS_FAILED",
      },
      "Feishu webhook processing failed but response is acknowledged",
    );
    return { status: 200, body: { ok: true, warning: "WEBHOOK_PROCESS_FAILED" } };
  }
};

export const createFeishuWebhookRouter = (deps: {
  auditService: ApprovalAuditService | AuditServiceLike;
  config: Pick<AppEnv, "FEISHU_VERIFICATION_TOKEN" | "FEISHU_ENCRYPT_KEY">;
  logger: Logger;
}): Router => {
  const router = Router();

  router.post("/approval", async (req, res) => {
    const response = await handleFeishuApprovalWebhook(req.body, deps);
    return res.status(response.status).json(response.body);
  });

  return router;
};
