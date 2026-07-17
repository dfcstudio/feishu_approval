import type { PrismaClient } from "@prisma/client";
import type { AppEnv } from "../../config/env.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { AppError, BusinessError, toErrorMessage } from "../../utils/errors.js";
import { sanitizeDatabaseText } from "../../utils/databaseText.js";
import { centsToDecimal, decimalToCents, moneyEquals } from "../../utils/money.js";
import { isLikelyUserId } from "../../utils/userIdentity.js";
import type { DedupeService, DuplicateMatchResult } from "../dedupe/DedupeService.js";
import { HashService } from "../dedupe/HashService.js";
import { ImageHashService } from "../dedupe/ImageHashService.js";
import type { FeishuClient } from "../feishu/FeishuClient.js";
import type { ParsedApprovalForm } from "../feishu/feishuTypes.js";
import type { OCRProvider } from "../ocr/OCRProvider.js";
import type { StorageProvider } from "../storage/StorageProvider.js";
import type { FeishuNotifyService } from "../notify/FeishuNotifyService.js";
import { parseApprovalForm } from "./parseApprovalForm.js";
import { extractInvoiceBuyerName, invoiceTitleMatches } from "./invoiceTitle.js";

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
      reviewStorageProvider?: StorageProvider;
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
    const skipped = await this.prepareAuditRun(db, instanceCode, saveFiles, status);
    if (skipped) return skipped;

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
      const allDuplicateMatches: DuplicateMatchResult[] = [];

      for (const attachment of approval.attachments) {
        const fileBuffer = await this.deps.feishuClient.downloadApprovalFile(attachment);
        // Feishu sometimes returns only a signed download URL and no filename or
        // MIME type. Detect spreadsheets from their bytes so an attached expense
        // workbook is not counted as an invoice that failed OCR.
        if (attachment.documentType === "INVOICE" && isSpreadsheetFile(fileBuffer)) continue;
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
          await db.paymentEvidence.update({
            where: { id: existingEvidence.id },
            data: {
              approvalAmount: approval.approvalAmount,
              approvalName,
              applicantId: approval.applicantId,
              applicantName: approval.applicantName,
              fileToken: attachment.fileToken,
              fileName,
              mimeType,
              fileSize: attachment.size ?? fileBuffer.byteLength,
            },
          });
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
              fileToken: attachment.fileToken,
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

        let ocr;
        let ocrFailed = false;
        try {
          ocr = await this.deps.ocrProvider.recognizePaymentEvidence({ fileBuffer, fileName, mimeType });
        } catch (error) {
          ocr = { rawText: "", confidence: 0 };
          ocrFailed = true;
          notificationWarnings.push(`OCR failed for one attachment: ${toErrorMessage(error)}`);
        }
        ocr = {
          ...ocr,
          rawText: sanitizeDatabaseText(ocr.rawText) ?? "",
          transactionId: sanitizeDatabaseText(ocr.transactionId),
          paidAt: sanitizeDatabaseText(ocr.paidAt),
          payee: sanitizeDatabaseText(ocr.payee),
        };
        const ocrConfidenceScore = toOcrConfidenceScore(ocr.confidence);
        let ocrReviewStorageKey: string | null = null;
        if (ocrConfidenceScore === 1 && this.deps.reviewStorageProvider) {
          try {
            const reviewCopy = await this.deps.reviewStorageProvider.save({ buffer: fileBuffer, fileName, mimeType });
            ocrReviewStorageKey = reviewCopy.storageKey;
          } catch (error) {
            notificationWarnings.push(`Cannot save low-confidence OCR review copy: ${toErrorMessage(error)}`);
          }
        }
        const documentType = classifyDocumentType(attachment.documentType, ocr.rawText, {
          amount: ocr.amount,
          transactionId: ocr.transactionId,
          paidAt: ocr.paidAt,
        });
        const invoiceBuyerName = documentType === "INVOICE" ? extractInvoiceBuyerName(ocr.rawText) : undefined;
        const invoiceTitleMatched = documentType === "INVOICE" && approval.receivingUnit && invoiceBuyerName
          ? invoiceTitleMatches(approval.receivingUnit, invoiceBuyerName, config.INVOICE_TITLE_ALIASES)
          : null;
        const paidAt = parseDate(ocr.paidAt);
        const amountMatched = Boolean(ocr.amount);
        const initialRisk = documentType === "SUPPORTING"
          ? { riskLevel: "LOW" as const, riskReasons: ["SUPPORTING_DOCUMENT"] }
          : determineRisk({ amountMatched, ocrAmount: ocr.amount, duplicateMatches: [] });
        if (ocrFailed) initialRisk.riskReasons.push("OCR_PROCESSING_FAILED");
        applyOcrConfidenceRisk(initialRisk, ocrConfidenceScore);
        applyInvoiceTitleRisk(initialRisk, documentType, approval.receivingUnit, invoiceBuyerName, invoiceTitleMatched);

        let evidence: { id: string };
        try {
          evidence = await db.paymentEvidence.create({
            data: {
              instanceCode: approval.instanceCode,
              fileToken: attachment.fileToken,
              documentType,
              invoiceBuyerName,
              invoiceTitleMatched,
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
              ocrConfidenceScore,
              ocrReviewStorageKey,
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

        if (documentType === "SUPPORTING") {
          evidenceIds.push(evidence.id);
          continue;
        }

        const duplicateMatches = await this.deps.dedupeService.findAndPersistMatches({
          currentEvidenceId: evidence.id,
          instanceCode: approval.instanceCode,
          sha256,
          transactionId: ocr.transactionId,
          perceptualHash,
          approvalAmount: approval.approvalAmount,
          ocrAmount: ocr.amount,
          paidAt,
          payee: ocr.payee,
        });
        allDuplicateMatches.push(...duplicateMatches);
        const finalRisk = determineRisk({
          amountMatched,
          ocrAmount: ocr.amount,
          duplicateMatches,
        });
        if (ocrFailed) finalRisk.riskReasons.push("OCR_PROCESSING_FAILED");
        applyOcrConfidenceRisk(finalRisk, ocrConfidenceScore);
        applyInvoiceTitleRisk(finalRisk, documentType, approval.receivingUnit, invoiceBuyerName, invoiceTitleMatched);

        await db.paymentEvidence.update({
          where: { id: evidence.id },
          data: {
            riskLevel: finalRisk.riskLevel,
            riskReasons: finalRisk.riskReasons,
          },
        });

        evidenceIds.push(evidence.id);
      }

      const notificationResult = await this.summarizeAndNotify(
        db, approval, approvalName, detail, status, allDuplicateMatches,
      );
      notificationWarnings.push(...notificationResult.warnings);

      return this.completeAuditRun(
        db, instanceCode, status, evidenceIds, notificationWarnings, notificationResult.delivered,
      );
    } catch (error) {
      return this.failAuditRun(db, instanceCode, approval, error);
    }
  }

  private async prepareAuditRun(
    db: PrismaClient, instanceCode: string, saveFiles: boolean, status?: string,
  ): Promise<ApprovalAuditResult | undefined> {
    const existing = await db.approvalAuditRun.findUnique({ where: { instanceCode } });
    if (status?.toUpperCase() === "APPROVED" && existing?.approvedNotifiedAt) {
      return { skipped: true, evidenceIds: [] };
    }
    if (!saveFiles && (existing?.status === "SUCCESS" || existing?.status === "SUCCESS_WITH_WARNING")) {
      return { skipped: true, evidenceIds: [] };
    }
    await db.approvalAuditRun.upsert({
      where: { instanceCode },
      create: { instanceCode, status: "PROCESSING", requestedStatus: status?.toUpperCase() },
      update: { status: "PROCESSING", errorMessage: null, ...(status ? { requestedStatus: status.toUpperCase() } : {}) },
    });
    return undefined;
  }

  private async summarizeAndNotify(
    db: PrismaClient,
    approval: ParsedApprovalForm,
    approvalName: string | null | undefined,
    detail: Awaited<ReturnType<FeishuClient["getApprovalInstanceDetail"]>>,
    status: string | undefined,
    duplicateMatches: DuplicateMatchResult[],
  ): Promise<{ warnings: string[]; delivered: boolean }> {
    const storedEvidences = await db.paymentEvidence.findMany({
      where: { instanceCode: approval.instanceCode }, orderBy: { createdAt: "asc" },
    });
    const summary = summarizeStoredEvidences(approval.approvalAmount, storedEvidences.map((item) => ({
      documentType: item.documentType as "PAYMENT" | "INVOICE" | "SUPPORTING",
      ocrAmount: item.ocrAmount?.toString(), riskLevel: item.riskLevel,
      riskReasons: Array.isArray(item.riskReasons)
        ? item.riskReasons.filter((reason): reason is string => typeof reason === "string")
        : [],
    })));
    await db.approvalAuditSummary.upsert({
      where: { instanceCode: approval.instanceCode },
      create: { instanceCode: approval.instanceCode, ...summary }, update: summary,
    });
    const representative = storedEvidences[0];
    const isApproved = status?.toUpperCase() === "APPROVED";
    const warning = await notifyBestEffort(() => this.deps.notifyService.sendAuditResult({
      notificationKey: `${isApproved ? "audit-approved" : "audit-summary"}:${approval.instanceCode}`,
      notificationStage: isApproved ? "APPROVED_HANDOFF" : "AUDIT",
      serialNumber: approval.serialNumber, approvalName, instanceCode: approval.instanceCode,
      applicantId: isApproved ? undefined : approval.applicantId, applicantName: approval.applicantName,
      departmentIds: approval.applicantDepartmentIds, currentApprovers: isApproved ? [] : approval.currentApprovers,
      approvalAmount: approval.approvalAmount,
      ocrAmount: (summary.paymentDocumentCount > 0 ? summary.paymentTotal : summary.invoiceTotal)
        ?? representative?.ocrAmount?.toString(),
      amountMatched: [summary.paymentTotalMatched, summary.invoiceTotalMatched]
        .filter((value) => value !== null).every(Boolean),
      transactionId: representative?.transactionId, paidAt: representative?.paidAt, payee: representative?.payee,
      riskLevel: summary.riskLevel, riskReasons: summary.riskReasons, duplicateMatches,
      ocrConfidenceScore: storedEvidences.length
        ? Math.min(...storedEvidences.map((item) => item.ocrConfidenceScore))
        : undefined,
      documentSummary: summary,
      extraRecipientOpenIds: isApproved ? approval.handlerOpenIds : pendingRecipientOpenIds(detail),
    }));
    return { warnings: warning ? [warning] : [], delivered: !warning };
  }

  private async completeAuditRun(
    db: PrismaClient, instanceCode: string, requestedStatus: string | undefined,
    evidenceIds: string[], notificationWarnings: string[], approvedResultDelivered: boolean,
  ): Promise<ApprovalAuditResult> {
    const warning = notificationWarnings.join("\n") || undefined;
    await db.approvalAuditRun.update({
      where: { instanceCode },
      data: {
        status: warning ? "SUCCESS_WITH_WARNING" : "SUCCESS",
        errorMessage: warning ?? null,
        leaseUntil: null, leaseOwner: null, finishedAt: new Date(),
        ...(requestedStatus?.toUpperCase() === "APPROVED" && approvedResultDelivered
          ? { approvedNotifiedAt: new Date() }
          : {}),
      },
    });
    return { skipped: false, evidenceIds, ...(warning ? { warning } : {}) };
  }

  private async failAuditRun(
    db: PrismaClient, instanceCode: string, approval: ParsedApprovalForm | undefined, error: unknown,
  ): Promise<ApprovalAuditResult> {
    const errorMessage = toErrorMessage(error);
    const errorCode = error instanceof AppError ? error.errorCode : "AUDIT_FAILED";
    await db.approvalAuditRun.update({
      where: { instanceCode },
      data: { status: error instanceof BusinessError ? "SUCCESS_WITH_WARNING" : "FAILED", errorMessage },
    });
    const notificationWarning = await notifyBestEffort(() => this.deps.notifyService.sendManualReviewWarning({
      serialNumber: approval?.serialNumber, instanceCode, errorCode, message: errorMessage,
    }));
    if (error instanceof BusinessError) {
      return { skipped: false, evidenceIds: [], warning: [errorMessage, notificationWarning].filter(Boolean).join("\n") };
    }
    throw error;
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

const applyInvoiceTitleRisk = (
  decision: RiskDecision,
  documentType: "PAYMENT" | "INVOICE" | "SUPPORTING",
  receivingUnit?: string,
  buyerName?: string,
  matched?: boolean | null,
): void => {
  if (documentType !== "INVOICE") return;
  if (!receivingUnit) {
    decision.riskLevel = maxRisk(decision.riskLevel, "UNKNOWN");
    if (!decision.riskReasons.includes("APPROVAL_RECEIVING_UNIT_NOT_FOUND")) decision.riskReasons.push("APPROVAL_RECEIVING_UNIT_NOT_FOUND");
  } else if (!buyerName) {
    decision.riskLevel = maxRisk(decision.riskLevel, "UNKNOWN");
    if (!decision.riskReasons.includes("INVOICE_BUYER_NOT_FOUND")) decision.riskReasons.push("INVOICE_BUYER_NOT_FOUND");
  } else if (matched === false) {
    decision.riskLevel = maxRisk(decision.riskLevel, "MEDIUM");
    if (!decision.riskReasons.includes("INVOICE_TITLE_MISMATCH")) decision.riskReasons.push("INVOICE_TITLE_MISMATCH");
  }
};

/** Converts provider confidence (0..1) to the user-facing five-point scale. */
export const toOcrConfidenceScore = (confidence: number): 1 | 2 | 3 | 4 | 5 =>
  Math.max(1, Math.min(5, Math.ceil(confidence * 5))) as 1 | 2 | 3 | 4 | 5;

const applyOcrConfidenceRisk = (decision: RiskDecision, score: number): void => {
  if (score !== 1) return;
  decision.riskLevel = maxRisk(decision.riskLevel, "UNKNOWN");
  if (!decision.riskReasons.includes("OCR_CONFIDENCE_SCORE_1")) decision.riskReasons.push("OCR_CONFIDENCE_SCORE_1");
};

export const summarizeStoredEvidences = (expenseSummaryAmount: string, documents: Array<{
  documentType: "PAYMENT" | "INVOICE" | "SUPPORTING"; ocrAmount?: string | null; riskLevel: RiskDecision["riskLevel"]; riskReasons: string[];
}>) => {
  const summarize = (type: "PAYMENT" | "INVOICE") => {
    const selected = documents.filter((d) => d.documentType === type);
    const recognized = selected.filter((d) => d.ocrAmount);
    const total = recognized.length ? centsToDecimal(recognized.reduce((sum, d) => sum + decimalToCents(d.ocrAmount!), 0)) : null;
    return { count: selected.length, recognizedCount: recognized.length, total, matched: selected.length ? recognized.length === selected.length && moneyEquals(expenseSummaryAmount, total) : null };
  };
  const payment = summarize("PAYMENT"); const invoice = summarize("INVOICE");
  let riskLevel: RiskDecision["riskLevel"] = "LOW"; const reasons = new Set<string>();
  for (const d of documents.filter((item) => item.documentType !== "SUPPORTING")) {
    riskLevel = maxRisk(riskLevel, d.riskLevel); d.riskReasons.forEach((r) => reasons.add(r));
  }
  for (const d of documents.filter((item) => item.riskReasons.includes("OCR_CONFIDENCE_SCORE_1"))) {
    riskLevel = maxRisk(riskLevel, "UNKNOWN");
    reasons.add("OCR_CONFIDENCE_SCORE_1");
  }
  for (const [prefix, item] of [["PAYMENT", payment], ["INVOICE", invoice]] as const) {
    if (!item.count) continue;
    if (item.recognizedCount !== item.count) { riskLevel = maxRisk(riskLevel, "UNKNOWN"); reasons.add(`${prefix}_AMOUNT_INCOMPLETE`); }
    else if (!item.matched) { riskLevel = maxRisk(riskLevel, "MEDIUM"); reasons.add(`${prefix}_TOTAL_MISMATCH`); }
  }
  if (payment.count === 0 && invoice.count === 0) {
    riskLevel = maxRisk(riskLevel, "HIGH");
    reasons.add("VALID_EVIDENCE_NOT_FOUND");
  }
  return { expenseSummaryAmount, paymentDocumentCount: payment.count, paymentRecognizedCount: payment.recognizedCount,
    paymentTotal: payment.total, paymentTotalMatched: payment.matched, invoiceDocumentCount: invoice.count,
    invoiceRecognizedCount: invoice.recognizedCount, invoiceTotal: invoice.total, invoiceTotalMatched: invoice.matched,
    supportingDocumentCount: documents.filter((item) => item.documentType === "SUPPORTING").length,
    riskLevel, riskReasons: [...reasons] };
};

const INVOICE_CONTENT_MARKERS = [
  /发票(?:号码|代码)/u,
  /购买方(?:信息|名称)?/u,
  /销售方(?:信息|名称)?/u,
  /价税合计/u,
];

/**
 * Keep explicit invoice-field classification, and upgrade generic/payment
 * attachments only when OCR text contains multiple independent invoice fields.
 */
export const classifyDocumentType = (
  fieldType: "PAYMENT" | "INVOICE",
  rawText?: string | null,
  recognized?: { amount?: string | null; transactionId?: string | null; paidAt?: string | null },
): "PAYMENT" | "INVOICE" | "SUPPORTING" => {
  if (fieldType === "INVOICE") return "INVOICE";
  const text = rawText?.replace(/\s+/gu, "") ?? "";
  const markerCount = INVOICE_CONTENT_MARKERS.filter((marker) => marker.test(text)).length;
  if (markerCount >= 2) return "INVOICE";
  if (!recognized) return "PAYMENT";
  const hasAmount = Boolean(recognized.amount) || /(?:¥|￥|金额|实付|转账)[：:]?-?\d+(?:\.\d{1,2})?/u.test(text);
  const hasTransactionId = Boolean(recognized.transactionId)
    || /(?:转账单号|交易单号|订单号|交易号|流水号|商户单号)[：:]?[A-Z0-9]{8,}/iu.test(text);
  const hasPaidAt = Boolean(recognized.paidAt)
    || /(?:转账时间|交易时间|支付时间|付款时间|创建时间)[：:]?20\d{2}年?\d{1,2}月?\d{1,2}日?/u.test(text);
  const bankMarkerCount = [
    /(?:交易卡号|交易账户|付款账号|付款账户)/u,
    /(?:对方账户|对方户名|收款账户|收款户名)/u,
    /(?:记账金额|交易金额|收支详情|业务摘要)/u,
  ].filter((marker) => marker.test(text)).length;
  const hasBankTransferDetails = bankMarkerCount >= 2;
  return hasAmount && hasPaidAt && (hasTransactionId || hasBankTransferDetails) ? "PAYMENT" : "SUPPORTING";
};

export const isSpreadsheetFile = (buffer: Buffer): boolean => {
  // XLSX/XLSM/XLSB are ZIP containers whose entry names are present in the
  // central directory. This avoids adding a ZIP dependency just for detection.
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const container = buffer.toString("latin1");
    return container.includes("xl/workbook.") || container.includes("xl/worksheets/");
  }
  // Legacy binary .xls uses the OLE Compound File signature.
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
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

const pendingRecipientOpenIds = (
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
  if (!applicantId || (currentName && currentName !== applicantId && !isLikelyUserId(currentName))) return approval;

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
