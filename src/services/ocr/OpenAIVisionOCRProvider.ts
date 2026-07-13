import axios, { type AxiosInstance } from "axios";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  md_results?: string;
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

const execFileAsync = promisify(execFile);

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

    if (input.fileBuffer.length === 0) {
      return { rawText: "", confidence: 0 };
    }

    const detectedMimeType = detectMimeType(input.fileName, input.fileBuffer);
    const mimeType = input.mimeType && input.mimeType !== "application/octet-stream"
      ? input.mimeType
      : detectedMimeType;
    if (!isSupportedVisionFile(input.fileName, mimeType)) {
      return extractPaymentFieldsFromTextFallback(input);
    }

    const visionInput = mimeType === "application/pdf"
      ? { buffer: await convertPdfToPng(input.fileBuffer), mimeType: "image/png" }
      : { buffer: input.fileBuffer, mimeType };
    const dataUrl = toDataUrl(visionInput.buffer, visionInput.mimeType);

    if (isGlmOcr(this.config)) {
      const response = await postWithOcrErrorHandling(() =>
        this.http.post<VisionModelResponse>("/layout_parsing", {
          model: this.config.AI_VISION_MODEL.toLowerCase(),
          file: dataUrl,
        }),
      );
      const rawText = response.data.md_results?.trim();
      if (!rawText) {
        throw new AppError("GLM-OCR response did not contain md_results", "AI_OCR_EMPTY_RESPONSE", 502);
      }
      return extractPaymentFields(rawText);
    }

    const response = await retry(
      () => this.http.post<VisionModelResponse>(requestPath(this.config), requestBody(this.config, dataUrl)),
      { attempts: 2, delayMs: 800 },
    );

    const text = extractResponseText(response.data);
    return normalizeOcrJson(text);
  }
}

export class OpenAIVisionOCRProvider extends AIVisionOCRProvider {}

const isGlmOcr = (config: AppEnv): boolean => config.AI_VISION_MODEL.trim().toLowerCase() === "glm-ocr";

const postWithOcrErrorHandling = async (
  request: () => Promise<{ data: VisionModelResponse }>,
): Promise<{ data: VisionModelResponse }> => {
  try {
    return await retry(request, { attempts: 2, delayMs: 800 });
  } catch (error) {
    const upstreamMessage = axios.isAxiosError(error)
      ? (error.response?.data as { error?: { message?: unknown } } | undefined)?.error?.message
      : undefined;
    throw new AppError(
      typeof upstreamMessage === "string" ? `AI OCR request failed: ${upstreamMessage}` : "AI OCR request failed",
      "AI_OCR_REQUEST_FAILED",
      502,
      { upstreamStatus: axios.isAxiosError(error) ? error.response?.status : undefined },
    );
  }
};

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
    payee: cleanPayee(data.payee) ?? fallback?.payee,
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

const requestPath = (config: AppEnv): string => {
  if (config.AI_VISION_API_STYLE === "chat_completions") {
    return config.AI_VISION_BASE_URL.includes("/v4") || config.AI_VISION_BASE_URL.includes("/v1")
      ? "/chat/completions"
      : "/v1/chat/completions";
  }
  return config.AI_VISION_BASE_URL.includes("/v1") ? "/responses" : "/v1/responses";
};

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
  "你是企业报销付款凭证审核助手，专门识别发票和付款截图。",
  "请只根据文件或图片中可见内容提取字段，不要猜测、不要补全。",
  "只输出 JSON，不要 Markdown。",
  "JSON 字段：rawText, amount, transactionId, paidAt, payee, confidence。",
  "amount：发票取价税合计，付款截图取实际扣款金额；使用数字字符串并保留两位小数。",
  "transactionId：提取发票号码、交易单号或商户单号。",
  "paidAt：尽量使用 YYYY-MM-DD HH:mm:ss。",
  "payee：提取销售方或收款商户全称，不要包含“名称”“商户全称”等字段前缀。",
  "confidence：0 到 1 之间的数字；无法识别的字段返回 null。",
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

const cleanPayee = (value?: string | null): string | undefined => {
  const text = cleanOptional(value);
  if (!text) return undefined;
  return text
    .replace(/^(?:商户全称|全称|商户名称|商户|收款方|收款人|对方|销售方名称|名称)\s*[:：]?\s*/u, "")
    .trim() || undefined;
};

const convertPdfToPng = async (pdfBuffer: Buffer): Promise<Buffer> => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-ocr-"));
  const pdfPath = join(directory, "input.pdf");
  const pngPath = join(directory, "output.png");
  try {
    await writeFile(pdfPath, pdfBuffer);
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", pdfPath, "--out", pngPath], {
      timeout: 15_000,
    });
    return await readFile(pngPath);
  } catch (error) {
    throw new AppError("Failed to convert PDF evidence to PNG", "PDF_CONVERSION_FAILED", 502, {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const toDataUrl = (buffer: Buffer, mimeType?: string): string =>
  `data:${normalizeImageMimeType(mimeType)};base64,${buffer.toString("base64")}`;

const normalizeImageMimeType = (mimeType?: string): string => {
  if (mimeType?.startsWith("image/") || mimeType === "application/pdf") return mimeType;
  return "image/png";
};

const detectMimeType = (fileName: string, buffer: Buffer): string => {
  if (buffer[0] === 0x25 && buffer[1] === 0x50) return "application/pdf";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  if (/\.pdf$/i.test(fileName)) return "application/pdf";
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  return "application/octet-stream";
};

const isSupportedVisionFile = (fileName: string, mimeType?: string): boolean => {
  if (mimeType?.startsWith("image/")) return true;
  if (mimeType === "application/pdf") return true;
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(fileName);
};

const extractPaymentFieldsFromTextFallback = (input: {
  fileBuffer: Buffer;
  fileName: string;
}): PaymentOCRResult => {
  const bufferText = input.fileBuffer.toString("utf8");
  return extractPaymentFields([decodeURIComponent(input.fileName), bufferText].join("\n"));
};
