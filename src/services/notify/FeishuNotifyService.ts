import type { AppEnv } from "../../config/env.js";
import type { FeishuClient } from "../feishu/FeishuClient.js";
import type { DuplicateMatchResult } from "../dedupe/DedupeService.js";
import type { Prisma, PrismaClient, RiskLevel } from "@prisma/client";
import type { ApprovalApprover } from "../feishu/feishuTypes.js";
import { NotificationRouter, type NotificationRecipient } from "./NotificationRouter.js";

export interface AuditNotificationInput {
  serialNumber?: string | null;
  instanceCode: string;
  approvalName?: string | null;
  applicantName?: string | null;
  approvalAmount: string;
  ocrAmount?: string | null;
  amountMatched: boolean | null;
  transactionId?: string | null;
  paidAt?: Date | string | null;
  payee?: string | null;
  riskLevel: string;
  riskReasons: string[];
  duplicateMatches: DuplicateMatchResult[];
  extraRecipientOpenIds?: string[];
  applicantId?: string | null;
  departmentIds?: string[];
  currentApprovers?: ApprovalApprover[];
  notificationKey?: string;
  documentSummary?: {
    paymentDocumentCount: number; paymentRecognizedCount: number; paymentTotal?: string | null; paymentTotalMatched?: boolean | null;
    invoiceDocumentCount: number; invoiceRecognizedCount: number; invoiceTotal?: string | null; invoiceTotalMatched?: boolean | null;
  };
}

const RISK_CN: Record<string, string> = {
  OCR_AMOUNT_NOT_FOUND: "OCR未识别金额",
  AMOUNT_MISMATCH: "金额不一致",
  DUPLICATE_SHA256: "文件完全重复(重复报销)",
  DUPLICATE_TRANSACTION_ID: "交易号重复(重复报销)",
  DUPLICATE_PERCEPTUAL_HASH: "图片高度相似(疑似重复报销)",
  DUPLICATE_COMPOSITE: "金额+日期+收款方综合重复",
  FIELD_PARSE_FAILED: "审批字段解析失败",
  AI_OCR_SCHEMA_INVALID: "AI OCR返回格式异常",
  AI_OCR_EMPTY_RESPONSE: "AI OCR返回空内容",
};

const RISK_COLORS: Record<string, string> = {
  HIGH: "red",
  MEDIUM: "orange",
  LOW: "green",
  UNKNOWN: "grey",
};

const riskEmoji = (level: string): string => {
  switch (level) {
    case "HIGH":
      return "🔴";
    case "MEDIUM":
      return "🟡";
    case "LOW":
      return "🟢";
    default:
      return "⚪";
  }
};

export class FeishuNotifyService {
  private readonly router: NotificationRouter;
  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly config: Pick<
      AppEnv,
      "FEISHU_NOTIFY_RECEIVE_ID_TYPE" | "FEISHU_NOTIFY_RECEIVE_ID" | "FEISHU_APPROVAL_DETAIL_URL_TEMPLATE"
    >,
    private readonly db?: PrismaClient,
  ) { this.router = new NotificationRouter(db, config); }

  async sendAuditResult(input: AuditNotificationInput): Promise<void> {
    const approvalUrl = buildApprovalDetailUrl(input.instanceCode, this.config.FEISHU_APPROVAL_DETAIL_URL_TEMPLATE);
    const elements: Record<string, unknown>[] = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**审批编号：**${input.serialNumber ?? input.instanceCode}`,
            `**审批单：**${input.approvalName ?? "未识别"}`,
            `**报销人：**${input.applicantName ?? "未识别"}`,
            `**审批金额：**${input.approvalAmount}`,
            `**OCR 识别金额：**${input.ocrAmount ?? "未识别"}`,
            `**金额核对：**${formatAmountMatched(input.amountMatched)}`,
          ].join("\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**交易号：**${input.transactionId ?? "未识别"}`,
            `**付款时间：**${formatValue(input.paidAt)}`,
            `**收款方：**${input.payee ?? "未识别"}`,
          ].join("\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**风险等级：**${riskEmoji(input.riskLevel)} ${input.riskLevel}`,
            `**风险原因：**${
              input.riskReasons.length ? input.riskReasons.map((reason) => RISK_CN[reason] ?? reason).join(", ") : "无"
            }`,
          ].join("\n"),
        },
      },
    ];

    if (input.documentSummary) {
      const s = input.documentSummary;
      elements.push({ tag: "hr" }, { tag: "div", text: { tag: "lark_md", content: [
        `**付款凭证汇总：**${s.paymentRecognizedCount}/${s.paymentDocumentCount} 张，合计 ${s.paymentTotal ?? "无法计算"}，${formatSummaryMatched(s.paymentTotalMatched)}`,
        `**发票汇总：**${s.invoiceRecognizedCount}/${s.invoiceDocumentCount} 张，合计 ${s.invoiceTotal ?? "无法计算"}，${formatSummaryMatched(s.invoiceTotalMatched)}`,
      ].join("\n") } });
    }

    if (input.duplicateMatches.length > 0) {
      const seenMatches = new Set<string>();
      const uniqueMatches = input.duplicateMatches.filter((match) => {
        const key = `${match.matchType}:${match.matchedEvidence.instanceCode}`;
        if (seenMatches.has(key)) return false;
        seenMatches.add(key);
        return true;
      });
      const duplicateLines = uniqueMatches.slice(0, 3).map((match) => {
        const evidence = match.matchedEvidence;
        return [
          `**${match.matchType}** score: ${match.score.toFixed(2)}`,
          `历史实例: ${evidence.instanceCode}`,
          `历史报销人: ${evidence.applicantName ?? "未知"}`,
          `历史金额: ${String(evidence.approvalAmount ?? "未知")}`,
          `提交时间: ${formatValue(evidence.createdAt)}`,
        ].join(" / ");
      });
      if (uniqueMatches.length > 3) duplicateLines.push(`...共 ${uniqueMatches.length} 条匹配`);

      elements.push(
        { tag: "hr" },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**重复匹配明细：**\n${duplicateLines.join("\n")}`,
          },
        },
      );
    }

    elements.push(
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "📋 查看审批详情" },
            type: "default",
            url: approvalUrl,
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "本结果由 OCR + 历史查重自动生成，仅供辅助审核，请人工复核。",
          },
        ],
      },
    );

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: `报销辅助审核 ${riskEmoji(input.riskLevel)}` },
        template: RISK_COLORS[input.riskLevel] ?? "grey",
      },
      elements,
    };

    const recipients = await this.router.resolve({
      riskLevel: input.riskLevel as RiskLevel, applicantId: input.applicantId,
      departmentIds: input.departmentIds ?? [], currentApprovers: input.currentApprovers ?? [],
      extraRecipientOpenIds: input.extraRecipientOpenIds,
    });
    await Promise.all(recipients.map((recipient) => this.deliverOrEnqueueCard(
      `${input.notificationKey ?? `audit:${input.instanceCode}`}:${recipient.receiveIdType}:${recipient.receiveId}`, recipient, card,
    )));
  }

  async sendManualReviewWarning(input: {
    serialNumber?: string | null;
    instanceCode: string;
    errorCode: string;
    message: string;
  }): Promise<void> {
    const approvalUrl = buildApprovalDetailUrl(input.instanceCode, this.config.FEISHU_APPROVAL_DETAIL_URL_TEMPLATE);

    await this.deliverOrEnqueueCard(`warning:${input.instanceCode}:${input.errorCode}`, {
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      role: "FIXED_GROUP",
    },
    {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "报销辅助审核 ⚪ 需人工处理" },
          template: "grey",
        },
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: [
                `**审批编号：**${input.serialNumber ?? input.instanceCode}`,
                `**错误代码：**${input.errorCode}`,
                `**原因：**${input.message}`,
              ].join("\n"),
            },
          },
          { tag: "hr" },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "📋 查看审批详情" },
                type: "default",
                url: approvalUrl,
              },
            ],
          },
          {
            tag: "note",
            elements: [
              {
                tag: "plain_text",
                content: "OCR 或字段解析失败，请人工审核该审批单。",
              },
            ],
          },
        ],
      });
  }

  async sendOriginalFileSaved(input: {
    serialNumber?: string | null;
    instanceCode: string;
    fileName: string;
    storageKey?: string | null;
  }): Promise<void> {
    const approvalUrl = buildApprovalDetailUrl(input.instanceCode, this.config.FEISHU_APPROVAL_DETAIL_URL_TEMPLATE);

    await this.deliverOrEnqueueCard(`saved:${input.instanceCode}:${input.storageKey ?? input.fileName}`, {
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      role: "FIXED_GROUP",
    }, {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "报销凭证原件已保存" },
          template: "green",
        },
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: [
                `**审批编号：**${input.serialNumber ?? input.instanceCode}`,
                `**文件名：**${input.fileName}`,
                `**存储键：**${input.storageKey ?? "未返回"}`,
              ].join("\n"),
            },
          },
          { tag: "hr" },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "📋 查看审批详情" },
                type: "default",
                url: approvalUrl,
              },
            ],
          },
        ],
      });
  }

  async processNext(): Promise<boolean> {
    if (!this.db) return false;
    const now = new Date();
    const item = await this.db.notificationOutbox.findFirst({ where: { OR: [
      { status: { in: ["PENDING", "FAILED"] }, nextRetryAt: { lte: now } }, { status: "SENDING", leaseUntil: { lt: now } },
    ] }, orderBy: { nextRetryAt: "asc" } });
    if (!item) return false;
    const claimed = await this.db.notificationOutbox.updateMany({ where: { id: item.id, OR: [
      { status: { in: ["PENDING", "FAILED"] } }, { status: "SENDING", leaseUntil: { lt: now } },
    ] }, data: { status: "SENDING", leaseUntil: new Date(Date.now() + 60_000) } });
    if (!claimed.count) return false;
    try {
      const payload = item.payload as unknown as { receiveIdType: NotificationRecipient["receiveIdType"]; receiveId: string; card: Record<string, unknown> };
      await this.feishuClient.sendInteractiveCard(payload);
      await this.db.notificationOutbox.update({ where: { id: item.id }, data: { status: "SENT", sentAt: new Date(), leaseUntil: null } });
    } catch (error) {
      await this.db.notificationOutbox.update({ where: { id: item.id }, data: { status: "FAILED", retryCount: { increment: 1 }, nextRetryAt: new Date(Date.now() + 30_000), leaseUntil: null, lastError: error instanceof Error ? error.message : String(error) } });
    }
    return true;
  }

  private async deliverOrEnqueueCard(dedupeKey: string, recipient: NotificationRecipient, card: Record<string, unknown>): Promise<void> {
    const payload = { receiveIdType: recipient.receiveIdType, receiveId: recipient.receiveId, card };
    if (!recipient.receiveId) return;
    if (!this.db) return this.feishuClient.sendInteractiveCard(payload);
    await this.db.notificationOutbox.upsert({ where: { dedupeKey }, create: {
      kind: "FEISHU_INTERACTIVE", dedupeKey, recipientRole: recipient.role,
      receiveIdType: recipient.receiveIdType, receiveId: recipient.receiveId, payload: payload as Prisma.InputJsonValue,
    }, update: {} });
  }
}

const formatAmountMatched = (value: boolean | null): string => {
  if (value === true) return "✅ 一致";
  if (value === false) return "❌ 不一致";
  return "⚠️ 无法判断";
};
const formatSummaryMatched = (value?: boolean | null): string => value == null ? "无可比附件" : value ? "✅ 与费用明细汇总一致" : "❌ 与费用明细汇总不一致";

const formatValue = (value: unknown): string => {
  if (!value) return "未识别";
  if (value instanceof Date) return formatLocalDate(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return formatLocalDate(parsed);
  }
  return String(value);
};

const formatLocalDate = (value: Date): string => {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return [
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  ].join(" ");
};

export const buildApprovalDetailUrl = (instanceCode: string, template: string): string =>
  template.includes("{instanceCode}")
    ? template.replaceAll("{instanceCode}", encodeURIComponent(instanceCode))
    : template.endsWith("=") || template.endsWith("/")
      ? `${template}${encodeURIComponent(instanceCode)}`
      : `${template}${template.includes("?") ? "&" : "?"}instance_code=${encodeURIComponent(instanceCode)}`;
