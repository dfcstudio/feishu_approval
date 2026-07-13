import { z } from "zod";
import { createDecipheriv, createHash } from "node:crypto";
import { AppError } from "../../utils/errors.js";
import type { FeishuApprovalEvent, UnknownRecord } from "./feishuTypes.js";

const eventPayloadSchema = z
  .object({
    token: z.string().optional(),
    challenge: z.string().optional(),
    type: z.string().optional(),
    encrypt: z.string().optional(),
    schema: z.string().optional(),
    header: z
      .object({
        token: z.string().optional(),
        event_type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    event: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type FeishuWebhookPayload = z.infer<typeof eventPayloadSchema>;

export const parseFeishuWebhookPayload = (body: unknown): FeishuWebhookPayload => {
  return eventPayloadSchema.parse(body);
};

export const isUrlVerification = (payload: FeishuWebhookPayload): boolean => {
  return payload.type === "url_verification" || typeof payload.challenge === "string";
};

export const verifyEventToken = (
  payload: FeishuWebhookPayload,
  expectedToken: string,
): void => {
  if (!expectedToken) return;
  const actualToken = payload.token ?? payload.header?.token;
  if (actualToken !== expectedToken) {
    throw new AppError("Invalid Feishu verification token", "FEISHU_TOKEN_INVALID", 401);
  }
};

export const decryptFeishuPayload = (payload: FeishuWebhookPayload, encryptKey?: string): FeishuWebhookPayload => {
  if (!payload.encrypt) return payload;
  if (!encryptKey) throw new AppError("Encrypted callback received without key", "FEISHU_ENCRYPT_KEY_MISSING", 401);
  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.encrypt, "base64")), decipher.final()]);
    return parseFeishuWebhookPayload(JSON.parse(plaintext.toString("utf8")));
  } catch {
    throw new AppError("Cannot decrypt Feishu callback", "FEISHU_DECRYPT_FAILED", 401);
  }
};

export const extractApprovalEvent = (
  payload: FeishuWebhookPayload,
): FeishuApprovalEvent | null => {
  const eventType = payload.header?.event_type ?? payload.event?.type ?? payload.type;
  const isApprovalEvent =
    typeof eventType === "string" &&
    (eventType.includes("approval") || eventType.includes("instance"));
  if (!isApprovalEvent) return null;

  const event = (payload.event ?? payload) as UnknownRecord;
  const instanceCode = findFirstString(event, [
    "instance_code",
    "instanceCode",
    "approval_instance_code",
    "approvalInstanceCode",
    "code",
  ]);

  if (!instanceCode) return null;

  return {
    instanceCode,
    status: findFirstString(event, ["status", "instance_status", "approval_status"]),
    raw: event,
  };
};

export const shouldAuditApprovalStatus = (status?: string): boolean => {
  if (!status) return false;
  const normalized = status.toUpperCase();
  return normalized === "PENDING" || normalized === "APPROVED";
};

const findFirstString = (record: UnknownRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};
