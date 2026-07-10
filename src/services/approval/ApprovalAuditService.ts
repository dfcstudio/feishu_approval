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
import type { ParsedApprovalForm } from "../feishu/feishuTypes.js";
import type { OCRProvider } from "../ocr/OCRProvider.js";
import type { StorageProvider } from "../storage/StorageProvider.js";
import type { FeishuNotifyService } from "../notify/FeishuNotifyService.js";
import { parseApprovalForm } from "./parseApprovalForm.js";

const APPROVAL_NAME_MAP: Record<string, string> = {
  "BA2807BA-3FEC-4160-BAF8-F0F0FE91E109": "采购报销（有票）",
  "720BFDB8-57D8-4808-AFC5-5312063D903A": "采购报销（无票）",
  "CB1E3C0E-073F-4C01-A6D1-6EBF27207BBB": "费用报销（有票）",
  "670EBDCD-1059-461E-AA29-6D13914A1971": "费用报销（无票）",
};

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

  async audit(instanceCode: string, saveFiles = true, status?: string): Promise<ApprovalAuditResult> {
    const db = this.deps.db ?? prisma;
    const config = this.deps.config ?? env;

    if (status?.toUpperCase() === "APPROVED") {
      const cachedEvidence = await db.paymentEvidence.findFirst({
        where: { instanceCode },
        orderBy: { createdAt: "desc" },
      });
      if (cachedEvidence) {
        let detail: Awaited<ReturnType<FeishuClient["getApprovalInstanceDetail"]>> | undefined;
        try {
          detail = await this.deps.feishuClient.getApprovalInstanceDetail(instanceCode);
        } catch {
          // Cached notification can still be sent while Feishu detail lookup is temporarily unavailable.
        }
        const notificationWarning = await notifyBestEffort(() =>
          this.deps.notifyService.sendAuditResult({
            serialNumber: detail?.serialNumber,
            instanceCode,
            approvalName:
              cachedEvidence.approvalName ??
              (detail?.approvalCode ? APPROVAL_NAME_MAP[detail.approvalCode] : undefined) ??
              detail?.approvalName,
            applicantName: cachedEvidence.applicantName ?? detail?.applicantName,
            approvalAmount: cachedEvidence.approvalAmount.toString(),
            ocrAmount: cachedEvidence.ocrAmount?.toString(),
            amountMatched: cachedEvidence.amountMatched,
            transactionId: cachedEvidence.transactionId,
            paidAt: cachedEvidence.paidAt,
            payee: cachedEvidence.payee,
            riskLevel: cachedEvidence.riskLevel,
            riskReasons: Array.isArray(cachedEvidence.riskReasons)
              ? cachedEvidence.riskReasons.filter((reason): reason is string => typeof reason === "string")
              : [],
            duplicateMatches: [],
            extraRecipientOpenIds: recipientOpenIds(detail),
          }),
        );
        return {
          skipped: true,
          evidenceIds: [cachedEvidence.id],
          ...(notificationWarning ? { warning: notificationWarning } : {}),
        };
      }
    }

    const existing = await db.approvalAuditRun.findUnique({ where: { instanceCode } });
    if (!saveFiles && (existing?.status === "SUCCESS" || existing?.status === "SUCCESS_WITH_WARNING")) {
      return { skipped: true, evidenceIds: [] };
    }

    await db.approvalAuditRun.upsert({
      where: { instanceCode },
      create: { instanceCode, status: "PROCESSING" },
      update: { status: "PROCESSING", errorMessage: null },
    });

    let approval: ParsedApprovalForm | undefined;
    try {
      const detail = await this.deps.feishuClient.getApprovalInstanceDetail(instanceCode);
      approval = parseApprovalForm(detail, config);
      approval = await resolveApplicantName(this.deps.feishuClient, approval, config.APPLICANT_NAME_MAP);
      const approvalName =
        approval.approvalName ??
        (approval.approvalCode ? APPROVAL_NAME_MAP[approval.approvalCode] : undefined) ??
        detail.approvalName;
      const evidenceIds: string[] = [];
      const notificationWarnings: string[] = [];

      for (const attachment of approval.attachments) {
        const fileBuffer = await this.deps.feishuClient.downloadApprovalFile(attachment);
        const fileName = attachment.name ?? `${attachment.fileToken}.bin`;
        const mimeType = attachment.mimeType;
        const sha256 = (this.deps.hashService ?? new HashService()).sha256(fileBuffer);
        const perceptualHash = await (this.deps.imageHashService ?? new ImageHashService()).perceptualHash(
          fileBuffer,
        );
        const existingEvidence = saveFiles
          ? await db.paymentEvidence.findFirst({
              where: { instanceCode: approval.instanceCode, sha256 },
              select: { id: true, storageKey: true },
            })
          : null;

        if (existingEvidence?.storageKey) {
          evidenceIds.push(existingEvidence.id);
          continue;
        }

        const storage = config.SAVE_ORIGINAL_FILE && saveFiles
          ? await this.deps.storageProvider.save({ buffer: fileBuffer, fileName, mimeType })
          : { storageKey: null, size: fileBuffer.byteLength };

        if (existingEvidence) {
          await db.paymentEvidence.update({
            where: { id: existingEvidence.id },
            data: {
              fileName,
              mimeType,
              fileSize: attachment.size ?? storage.size,
              storageKey: storage.storageKey,
              perceptualHash,
            },
          });
          if (storage.storageKey) {
            const notificationWarning = await notifyBestEffort(() =>
              this.deps.notifyService.sendOriginalFileSaved({
                serialNumber: approval?.serialNumber,
                instanceCode: approval?.instanceCode ?? instanceCode,
                fileName,
                storageKey: storage.storageKey,
              }),
            );
            if (notificationWarning) notificationWarnings.push(notificationWarning);
          }
          evidenceIds.push(existingEvidence.id);
          continue;
        }

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

        let evidence: { id: string };
        try {
          evidence = await db.paymentEvidence.create({
            data: {
              instanceCode: approval.instanceCode,
              applicantId: approval.applicantId,
              applicantName: approval.applicantName,
              approvalName,
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
            select: { id: true },
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          const duplicateEvidence = await db.paymentEvidence.findFirst({
            where: { instanceCode: approval.instanceCode, sha256 },
            select: { id: true, storageKey: true },
          });
          if (!duplicateEvidence) throw error;
          if (storage.storageKey && !duplicateEvidence.storageKey) {
            await db.paymentEvidence.update({
              where: { id: duplicateEvidence.id },
              data: {
                fileName,
                mimeType,
                fileSize: attachment.size ?? storage.size,
                storageKey: storage.storageKey,
                perceptualHash,
              },
            });
            const notificationWarning = await notifyBestEffort(() =>
              this.deps.notifyService.sendOriginalFileSaved({
                serialNumber: approval?.serialNumber,
                instanceCode: approval?.instanceCode ?? instanceCode,
                fileName,
                storageKey: storage.storageKey,
              }),
            );
            if (notificationWarning) notificationWarnings.push(notificationWarning);
          }
          evidenceIds.push(duplicateEvidence.id);
          continue;
        }

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

        const notificationWarning = await notifyBestEffort(() =>
          this.deps.notifyService.sendAuditResult({
            serialNumber: approval?.serialNumber,
            approvalName,
            instanceCode: approval?.instanceCode ?? instanceCode,
            applicantName: approval?.applicantName,
            approvalAmount: approval?.approvalAmount ?? "0.00",
            ocrAmount: ocr.amount,
            amountMatched: ocr.amount ? amountMatched : null,
            transactionId: ocr.transactionId,
            paidAt,
            payee: ocr.payee,
            riskLevel: finalRisk.riskLevel,
            riskReasons: finalRisk.riskReasons,
            duplicateMatches,
            extraRecipientOpenIds: recipientOpenIds(detail),
          }),
        );
        if (notificationWarning) notificationWarnings.push(notificationWarning);

        evidenceIds.push(evidence.id);
      }

      const notificationWarning = notificationWarnings.join("\n") || undefined;
      await db.approvalAuditRun.update({
        where: { instanceCode },
        data: {
          status: notificationWarning ? "SUCCESS_WITH_WARNING" : "SUCCESS",
          errorMessage: notificationWarning ?? null,
        },
      });

      return {
        skipped: false,
        evidenceIds,
        ...(notificationWarning ? { warning: notificationWarning } : {}),
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const errorCode = error instanceof BusinessError ? error.errorCode : "AUDIT_FAILED";
      const status = error instanceof BusinessError ? "SUCCESS_WITH_WARNING" : "FAILED";

      await db.approvalAuditRun.update({
        where: { instanceCode },
        data: { status, errorMessage },
      });

      const notificationWarning = await notifyBestEffort(() =>
        this.deps.notifyService.sendManualReviewWarning({
          serialNumber: approval?.serialNumber,
          instanceCode,
          errorCode,
          message: errorMessage,
        }),
      );

      if (error instanceof BusinessError) {
        return {
          skipped: false,
          evidenceIds: [],
          warning: [errorMessage, notificationWarning].filter(Boolean).join("\n"),
        };
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

const notifyBestEffort = async (send: () => Promise<void>): Promise<string | undefined> => {
  try {
    await send();
    return undefined;
  } catch (error) {
    return `Notification failed: ${toErrorMessage(error)}`;
  }
};

const recipientOpenIds = (
  detail?: Awaited<ReturnType<FeishuClient["getApprovalInstanceDetail"]>>,
): string[] => [
  ...(detail?.submitterOpenId ? [detail.submitterOpenId] : []),
  ...(detail?.approverOpenIds ?? []),
];

const resolveApplicantName = async (
  feishuClient: FeishuClient,
  approval: ParsedApprovalForm,
  applicantNameMap: AppEnv["APPLICANT_NAME_MAP"],
): Promise<ParsedApprovalForm> => {
  const applicantId = approval.applicantId?.trim();
  const currentName = approval.applicantName?.trim();
  if (!applicantId || (currentName && currentName !== applicantId)) return approval;

  const mappedName = applicantNameMap[applicantId];
  if (mappedName) return { ...approval, applicantName: mappedName };

  const resolvedName = await feishuClient.resolveUserName(applicantId);
  if (resolvedName) return { ...approval, applicantName: resolvedName };

  return approval;
};

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";
