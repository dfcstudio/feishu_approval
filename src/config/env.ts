import "dotenv/config";
import { z } from "zod";

const booleanFromString = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

const keyValueMap = z
  .string()
  .default("")
  .transform((value) =>
    Object.fromEntries(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const separatorIndex = item.indexOf(":");
          if (separatorIndex < 0) return [item, ""] as const;
          return [item.slice(0, separatorIndex).trim(), item.slice(separatorIndex + 1).trim()] as const;
        })
        .filter(([key, mappedValue]) => key && mappedValue),
    ),
  );

const stringArrayMap = z.string().default("{}").transform((value, context) => {
  try {
    return z.record(z.array(z.string())).parse(JSON.parse(value));
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a JSON object whose values are string arrays" });
    return z.NEVER;
  }
});

const fallbackEnv = (fallbackKey: string) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim()) return value;
    return process.env[fallbackKey];
  }, z.string().default(""));

const fallbackStringEnv = (fallbackKey: string, fallback: string) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim()) return value;
    return process.env[fallbackKey] || fallback;
  }, z.string().default(fallback));

const fallbackUrlEnv = (fallbackKey: string, fallback: string) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim()) return value;
    return process.env[fallbackKey] || fallback;
  }, z.string().url().default(fallback));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(7319),
  DATABASE_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/feishu_expense_audit"),
  FEISHU_APP_ID: z.string().default(""),
  FEISHU_APP_SECRET: z.string().default(""),
  FEISHU_VERIFICATION_TOKEN: z.string().default(""),
  FEISHU_ENCRYPT_KEY: z.string().default(""),
  FEISHU_API_BASE_URL: z.string().url().default("https://open.feishu.cn"),
  // Approval form attachments are served from both Feishu application and CDN domains.
  FEISHU_FILE_DOWNLOAD_ALLOWED_HOSTS: csv(
    "open.feishu.cn,*.feishu.cn,*.feishuapp.cn,*.feishucdn.com,*.larksuite.com,*.larksuitecdn.com",
  ),
  FEISHU_FILE_DOWNLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  FEISHU_NOTIFY_RECEIVE_ID_TYPE: z.enum(["open_id", "user_id", "chat_id"]).default("chat_id"),
  FEISHU_NOTIFY_RECEIVE_ID: z.string().default(""),
  // Native approval details must use Feishu's AppLink protocol; the web /approval/detail route is not valid.
  FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: z
    .string()
    .default(
      "https://applink.feishu.cn/client/mini_program/open?mode=appCenter&appId=cli_9cb844403dbb9108&path=pc%2Fpages%2Fin-process%2Findex%3FinstanceId%3D{instanceCode}",
    ),
  // Comma-separated Feishu user-id:name mappings; reload the service after changing .env.
  APPLICANT_NAME_MAP: keyValueMap,
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com"),
  OPENAI_VISION_MODEL: z.string().default("gpt-4o-mini"),
  AI_VISION_API_KEY: fallbackEnv("OPENAI_API_KEY"),
  AI_VISION_BASE_URL: fallbackUrlEnv("OPENAI_BASE_URL", "https://api.openai.com"),
  AI_VISION_MODEL: fallbackStringEnv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
  AI_VISION_FALLBACK_MODEL: z.string().default("glm-4.6v-flash"),
  AI_VISION_API_STYLE: z.enum(["responses", "chat_completions"]).default("responses"),
  APPROVAL_AMOUNT_FIELD_NAMES: csv("费用明细汇总,报销金额,金额,实付金额"),
  APPROVAL_ATTACHMENT_FIELD_NAMES: csv("付款凭证,支付截图,报销凭证,图片/视频,图片"),
  APPROVAL_INVOICE_FIELD_NAMES: csv("发票,发票附件,电子发票,发票图片,附件"),
  APPROVAL_RECEIVING_UNIT_FIELD_NAMES: csv("收票单位,报销单位"),
  INVOICE_TITLE_ALIASES: stringArrayMap,
  APPROVAL_APPLICANT_FIELD_NAMES: csv("申请人,报销人"),
  APPROVAL_HANDLER_FIELD_NAMES: csv("办理人,经办人,付款办理人"),
  LOCAL_STORAGE_DIR: z.string().default("./data/evidences"),
  OCR_REVIEW_DIR: z.string().default("./data/approval/ocr-review"),
  SAVE_ORIGINAL_FILE: booleanFromString.default(true),
  SAVE_OCR_RAW_TEXT: booleanFromString.default(false),
  PERCEPTUAL_HASH_DISTANCE_THRESHOLD: z.coerce.number().int().min(0).max(64).default(8),
  AUDIT_WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  AUDIT_JOB_LEASE_SECONDS: z.coerce.number().int().min(10).default(300),
  AUDIT_JOB_MAX_RETRIES: z.coerce.number().int().min(1).default(5),
  OCR_PROVIDER: z.enum(["mock", "openai", "ai-vision", "openai-compatible"]).default("mock"),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production") {
  const missing = [["FEISHU_VERIFICATION_TOKEN", env.FEISHU_VERIFICATION_TOKEN], ["FEISHU_ENCRYPT_KEY", env.FEISHU_ENCRYPT_KEY]]
    .filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
}
