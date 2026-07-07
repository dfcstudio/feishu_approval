import type { PrismaClient } from "@prisma/client";
import type { AppEnv } from "../../config/env.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { BusinessError, toErrorMessage } from "../../utils/errors.js";
import { moneyEquals } from "../../utils/money.js";
import type { DedupeService, DuplicateMatchResult } from "../dedupe/DedupeService.js";
import { HashService } from "../dedupe/HashService.js";
import { ImageHashService } from "../dedupe/ImageHashService.js";
import type { FeishuClient } from "../feishu/FeishuClient.js";
import type { OCRProvider } from "../ocr/OCRProvider.js";
import type { StorageProvider } from "../storage/StorageProvider.js";
import type { FeishuNotifyService } from "../notify/FeishuNotifyService.js";
import { parseApprovalForm } from "./parseApprovalForm.js";

export interface ApprovalAuditResult {
  skipped: boolean;
  evidenceIds: string[];
  warning?: string;
}

export interface RiskDecision {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  riskReasons: string[];
}

export class ApprovalAuditService {
  constructor(
    private readonly deps: {
      feishuClient: FeishuClient;
      ocrProvider: OCRProvider;
      storageProvider: StorageProvider;
      dedupeService: DedupeService;
      notifyService: FeishuNotifyService;
      db?: PrismaClient;
      hashService?: HashService;
      imageHashService?: ImageHashService;
      config?: AppEnv;
    },
  ) {}

  async audit(instanceCode: string): Promise<ApprovalAuditResult> {
    const db = this.deps.db ?? prisma;
    const config = this.deps.config ?? env;
    const existing = await db.approvalAuditRun.findUnique({ where: { instanceCode } });
    if (existing?.status === "SUCCESS" || existing?.status === "SUCCESS_WITH_WARNING") {
      return { skipped: true, evidenceIds: [] };
    }

    await db.approvalAuditRun.upsert({
      where: { instanceCode },
      create: { instanceCode, status: "PROCESSING" },
      update: { status: "PROCESSING", errorMessage: null },
    });

    try {
      const detail = await this.deps.feishuClient.getApprovalInstanceDetail(instanceCode);
      const approval = parseApprovalForm(detail, config);
      const evidenceIds: string[] = [];

      for (const attachment of approval.attachments) {
        const fileBuffer = await this.deps.feishuClient.downloadApprovalFile(attachment);
        const fileName = attachment.name ?? `${attachment.fileToken}.bin`;
        const mimeType = attachment.mimeType;
        const sha256 = (this.deps.hashService ?? new HashService()).sha256(fileBuffer);
        const perceptualHash = await (this.deps.imageHashService ?? new ImageHashService()).perceptualHash(
          fileBuffer,
        );
        const storage = config.SAVE_ORIGINAL_FILE
          ? await this.deps.storageProvider.save({ buffer: fileBuffer, fileName, mimeType })
          : { storageKey: null, size: fileBuffer.byteLength };

        const ocr = await this.deps.ocrProvider.recognizePaymentEvidence({
          fileBuffer,
          fileName,
          mimeType,
        });
        const paidAt = parseDate(ocr.paidAt);
        const amountMatched = Boolean(ocr.amount && moneyEquals(approval.approvalAmount, ocr.amount));
        const initialRisk = determineRisk({
          amountMatched,
          ocrAmount: ocr.amount,
          duplicateMatches: [],
        });

        const evidence = await db.paymentEvidence.create({
          data: {
            instanceCode: approval.instanceCode,
            applicantId: approval.applicantId,
            applicantName: approval.applicantName,
            approvalName: approval.approvalName,
            approvalAmount: approval.approvalAmount,
            ocrAmount: ocr.amount,
            amountMatched,
            transactionId: ocr.transactionId,
            paidAt,
            payee: ocr.payee,
            fileName,
            mimeType,
            fileSize: attachment.size ?? storage.size,
            storageKey: storage.storageKey,
            sha256,
            perceptualHash,
            ocrRawText: config.SAVE_OCR_RAW_TEXT ? ocr.rawText : null,
            ocrConfidence: ocr.confidence,
            riskLevel: initialRisk.riskLevel,
            riskReasons: initialRisk.riskReasons,
          },
        });

        const duplicateMatches = await this.deps.dedupeService.findAndPersistMatches({
          currentEvidenceId: evidence.id,
          sha256,
          transactionId: ocr.transactionId,
          perceptualHash,
          approvalAmount: approval.approvalAmount,
          paidAt,
          payee: ocr.payee,
        });
        const finalRisk = determineRisk({
          amountMatched,
          ocrAmount: ocr.amount,
          duplicateMatches,
        });

        await db.paymentEvidence.update({
          where: { id: evidence.id },
          data: {
            riskLevel: finalRisk.riskLevel,
            riskReasons: finalRisk.riskReasons,
          },
        });

        await this.deps.notifyService.sendAuditResult({
          approvalName: approval.approvalName,
          instanceCode: approval.instanceCode,
          applicantName: approval.applicantName,
          approvalAmount: approval.approvalAmount,
          ocrAmount: ocr.amount,
          amountMatched: ocr.amount ? amountMatched : null,
          transactionId: ocr.transactionId,
          paidAt,
          payee: ocr.payee,
          riskLevel: finalRisk.riskLevel,
          riskReasons: finalRisk.riskReasons,
          duplicateMatches,
        });

        evidenceIds.push(evidence.id);
      }

      await db.approvalAuditRun.update({
        where: { instanceCode },
        data: { status: "SUCCESS", errorMessage: null },
      });

      return { skipped: false, evidenceIds };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const errorCode = error instanceof BusinessError ? error.errorCode : "AUDIT_FAILED";
      const status = error instanceof BusinessError ? "SUCCESS_WITH_WARNING" : "FAILED";

      await db.approvalAuditRun.update({
        where: { instanceCode },
        data: { status, errorMessage },
      });

      await this.deps.notifyService.sendManualReviewWarning({
        instanceCode,
        errorCode,
        message: errorMessage,
      });

      if (error instanceof BusinessError) {
        return { skipped: false, evidenceIds: [], warning: errorMessage };
      }
      throw error;
    }
  }
}

export const determineRisk = (input: {
  amountMatched: boolean;
  ocrAmount?: string | null;
  duplicateMatches: DuplicateMatchResult[];
}): RiskDecision => {
  const reasons = new Set<string>();
  let riskLevel: RiskDecision["riskLevel"] = "LOW";

  if (!input.ocrAmount) {
    riskLevel = "UNKNOWN";
    reasons.add("OCR_AMOUNT_NOT_FOUND");
  } else if (!input.amountMatched) {
    riskLevel = maxRisk(riskLevel, "MEDIUM");
    reasons.add("AMOUNT_MISMATCH");
  }

  for (const match of input.duplicateMatches) {
    if (match.matchType === "SHA256") {
      riskLevel = maxRisk(riskLevel, "HIGH");
      reasons.add("DUPLICATE_SHA256");
    }
    if (match.matchType === "TRANSACTION_ID") {
      riskLevel = maxRisk(riskLevel, "HIGH");
      reasons.add("DUPLICATE_TRANSACTION_ID");
    }
    if (match.matchType === "PERCEPTUAL_HASH") {
      riskLevel = maxRisk(riskLevel, match.score >= 0.9 ? "HIGH" : "MEDIUM");
      reasons.add("DUPLICATE_PERCEPTUAL_HASH");
    }
    if (match.matchType === "COMPOSITE") {
      riskLevel = maxRisk(riskLevel, "MEDIUM");
      reasons.add("DUPLICATE_COMPOSITE");
    }
  }

  return {
    riskLevel,
    riskReasons: [...reasons],
  };
};

const riskOrder: Record<RiskDecision["riskLevel"], number> = {
  LOW: 0,
  UNKNOWN: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const maxRisk = (
  left: RiskDecision["riskLevel"],
  right: RiskDecision["riskLevel"],
): RiskDecision["riskLevel"] => (riskOrder[right] > riskOrder[left] ? right : left);

const parseDate = (value?: string): Date | null => {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};
