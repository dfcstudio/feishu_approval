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
  FEISHU_FILE_DOWNLOAD_ALLOWED_HOSTS: csv(
    "open.feishu.cn,*.feishu.cn,*.feishuapp.cn,*.larksuite.com,*.larksuitecdn.com",
  ),
  FEISHU_FILE_DOWNLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  FEISHU_NOTIFY_RECEIVE_ID_TYPE: z.enum(["open_id", "user_id", "chat_id"]).default("chat_id"),
  FEISHU_NOTIFY_RECEIVE_ID: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com"),
  OPENAI_VISION_MODEL: z.string().default("gpt-4o-mini"),
  AI_VISION_API_KEY: fallbackEnv("OPENAI_API_KEY"),
  AI_VISION_BASE_URL: fallbackUrlEnv("OPENAI_BASE_URL", "https://api.openai.com"),
  AI_VISION_MODEL: fallbackStringEnv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
  AI_VISION_API_STYLE: z.enum(["responses", "chat_completions"]).default("responses"),
  APPROVAL_AMOUNT_FIELD_NAMES: csv("报销金额,金额,实付金额"),
  APPROVAL_ATTACHMENT_FIELD_NAMES: csv("付款凭证,支付截图,报销凭证,附件,图片/视频,图片"),
  APPROVAL_APPLICANT_FIELD_NAMES: csv("申请人,报销人"),
  LOCAL_STORAGE_DIR: z.string().default("./data/evidences"),
  SAVE_ORIGINAL_FILE: booleanFromString.default(true),
  SAVE_OCR_RAW_TEXT: booleanFromString.default(false),
  PERCEPTUAL_HASH_DISTANCE_THRESHOLD: z.coerce.number().int().min(0).max(64).default(8),
  OCR_PROVIDER: z.enum(["mock", "openai", "ai-vision", "openai-compatible"]).default("mock"),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
