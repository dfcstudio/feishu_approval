import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { AppEnv } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";
import { normalizeMoney } from "../../utils/money.js";
import { retry } from "../../utils/retry.js";
import { extractPaymentFields } from "./MockOCRProvider.js";
import type { OCRProvider, PaymentOCRResult } from "./OCRProvider.js";

const ocrJsonSchema = z.object({
  rawText: z.string().default(""),
  amount: z.union([z.string(), z.number()]).nullable().optional(),
  transactionId: z.string().nullable().optional(),
  paidAt: z.string().nullable().optional(),
  payee: z.string().nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});

type VisionModelResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
};

export class AIVisionOCRProvider implements OCRProvider {
  private readonly http: AxiosInstance;

  constructor(private readonly config: AppEnv) {
    this.http = axios.create({
      baseURL: config.AI_VISION_BASE_URL,
      timeout: 45_000,
      headers: {
        Authorization: `Bearer ${config.AI_VISION_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
  }

  async recognizePaymentEvidence(input: {
    fileBuffer: Buffer;
    fileName: string;
    mimeType?: string;
  }): Promise<PaymentOCRResult> {
    if (!this.config.AI_VISION_API_KEY) {
      throw new AppError("AI_VISION_API_KEY is not configured", "AI_VISION_CONFIG_MISSING");
    }

    if (!isSupportedImage(input.fileName, input.mimeType)) {
      return extractPaymentFieldsFromTextFallback(input);
    }

    const dataUrl = toDataUrl(input.fileBuffer, input.mimeType);
    const response = await retry(
      () => this.http.post<VisionModelResponse>(requestPath(this.config), requestBody(this.config, dataUrl)),
      { attempts: 2, delayMs: 800 },
    );

    const text = extractResponseText(response.data);
    return normalizeOcrJson(text);
  }
}

export class OpenAIVisionOCRProvider extends AIVisionOCRProvider {}

export const normalizeOcrJson = (text: string): PaymentOCRResult => {
  const parsed = ocrJsonSchema.safeParse(JSON.parse(extractJsonObject(text)));
  if (!parsed.success) {
    throw new AppError("AI OCR response does not match expected schema", "AI_OCR_SCHEMA_INVALID", 502, {
      issues: parsed.error.issues,
    });
  }

  const data = parsed.data;
  const amount = safeNormalizeMoney(data.amount);
  const rawText = data.rawText.trim();
  const fallback = rawText ? extractPaymentFields(rawText) : undefined;

  return {
    rawText,
    amount: amount ?? fallback?.amount,
    transactionId: cleanOptional(data.transactionId) ?? fallback?.transactionId,
    paidAt: cleanOptional(data.paidAt) ?? fallback?.paidAt,
    payee: cleanOptional(data.payee) ?? fallback?.payee,
    confidence: data.confidence,
  };
};

export const extractResponseText = (response: VisionModelResponse): string => {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) return content.text;
    }
  }

  for (const choice of response.choices ?? []) {
    const content = choice.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item.text === "string" && item.text.trim()) return item.text;
      }
    }
  }

  throw new AppError("AI OCR response did not contain text output", "AI_OCR_EMPTY_RESPONSE", 502);
};

const requestPath = (config: AppEnv): string =>
  config.AI_VISION_API_STYLE === "chat_completions" ? "/v1/chat/completions" : "/v1/responses";

const requestBody = (config: AppEnv, dataUrl: string): unknown => {
  if (config.AI_VISION_API_STYLE === "chat_completions") {
    return {
      model: config.AI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ocrPrompt },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      temperature: 0,
    };
  }

  return {
    model: config.AI_VISION_MODEL,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: ocrPrompt,
          },
          {
            type: "input_image",
            image_url: dataUrl,
          },
        ],
      },
    ],
  };
};

const ocrPrompt = [
  "你是企业报销付款凭证审核助手。",
  "请只根据图片中可见内容提取字段，不要猜测、不要补全。",
  "只输出 JSON，不要 Markdown。",
  "JSON 字段：rawText, amount, transactionId, paidAt, payee, confidence。",
  "amount 使用数字字符串，保留两位小数；paidAt 尽量使用 YYYY-MM-DD HH:mm:ss；无法识别的字段返回 null。",
].join("\n");

const extractJsonObject = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AppError("AI OCR response is not JSON", "AI_OCR_JSON_INVALID", 502);
  }
  return candidate.slice(start, end + 1);
};

const safeNormalizeMoney = (value?: string | number | null): string | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  try {
    return normalizeMoney(value);
  } catch {
    return undefined;
  }
};

const cleanOptional = (value?: string | null): string | undefined => {
  const text = value?.trim();
  return text && text.toLowerCase() !== "null" ? text : undefined;
};

const toDataUrl = (buffer: Buffer, mimeType?: string): string =>
  `data:${normalizeImageMimeType(mimeType)};base64,${buffer.toString("base64")}`;

const normalizeImageMimeType = (mimeType?: string): string => {
  if (mimeType?.startsWith("image/")) return mimeType;
  return "image/png";
};

const isSupportedImage = (fileName: string, mimeType?: string): boolean => {
  if (mimeType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(fileName);
};

const extractPaymentFieldsFromTextFallback = (input: {
  fileBuffer: Buffer;
  fileName: string;
}): PaymentOCRResult => {
  const bufferText = input.fileBuffer.toString("utf8");
  return extractPaymentFields([decodeURIComponent(input.fileName), bufferText].join("\n"));
};
