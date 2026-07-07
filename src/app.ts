import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { env, type AppEnv } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { ApprovalAuditService } from "./services/approval/ApprovalAuditService.js";
import { DedupeService } from "./services/dedupe/DedupeService.js";
import { FeishuClient } from "./services/feishu/FeishuClient.js";
import { MockOCRProvider } from "./services/ocr/MockOCRProvider.js";
import { AIVisionOCRProvider } from "./services/ocr/OpenAIVisionOCRProvider.js";
import type { OCRProvider } from "./services/ocr/OCRProvider.js";
import { FeishuNotifyService } from "./services/notify/FeishuNotifyService.js";
import { LocalStorageProvider } from "./services/storage/LocalStorageProvider.js";
import { createFeishuWebhookRouter, type AuditServiceLike } from "./routes/feishuWebhook.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "FEISHU_APP_SECRET",
    "FEISHU_VERIFICATION_TOKEN",
    "OPENAI_API_KEY",
    "AI_VISION_API_KEY",
    "tenant_access_token",
    "*.tenant_access_token",
    "*.app_secret",
    "*.rawText",
  ],
});

export const createApp = (overrides?: {
  config?: AppEnv;
  auditService?: AuditServiceLike;
}) => {
  const config = overrides?.config ?? env;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(pinoHttp({ logger }));

  const auditService =
    overrides?.auditService ??
    (() => {
      const feishuClient = new FeishuClient(config);
      const notifyService = new FeishuNotifyService(feishuClient, config);
      return new ApprovalAuditService({
        feishuClient,
        ocrProvider: createOCRProvider(config),
        storageProvider: new LocalStorageProvider(config.LOCAL_STORAGE_DIR),
        dedupeService: new DedupeService(),
        notifyService,
        db: prisma,
        config,
      });
    })();

  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.use(
    "/webhooks/feishu",
    createFeishuWebhookRouter({
      auditService,
      config,
      logger,
    }),
  );

  return app;
};

const createOCRProvider = (config: AppEnv): OCRProvider => {
  if (
    config.OCR_PROVIDER === "openai" ||
    config.OCR_PROVIDER === "ai-vision" ||
    config.OCR_PROVIDER === "openai-compatible"
  ) {
    return new AIVisionOCRProvider(config);
  }
  return new MockOCRProvider();
};
