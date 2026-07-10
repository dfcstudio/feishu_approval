import type { AppEnv } from "../../config/env.js";
import type { FeishuClient } from "../feishu/FeishuClient.js";
import type { DuplicateMatchResult } from "../dedupe/DedupeService.js";

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
  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly config: Pick<
      AppEnv,
      "FEISHU_NOTIFY_RECEIVE_ID_TYPE" | "FEISHU_NOTIFY_RECEIVE_ID" | "FEISHU_APPROVAL_DETAIL_URL_TEMPLATE"
    >,
  ) {}

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

    await this.feishuClient.sendInteractiveCard({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      card,
    });

    const recipients = [...new Set(input.extraRecipientOpenIds ?? [])]
      .filter((receiveId) => receiveId && receiveId !== this.config.FEISHU_NOTIFY_RECEIVE_ID);
    await Promise.allSettled(
      recipients.map((receiveId) =>
        this.feishuClient.sendInteractiveCard({ receiveIdType: "open_id", receiveId, card }),
      ),
    );
  }

  async sendManualReviewWarning(input: {
    serialNumber?: string | null;
    instanceCode: string;
    errorCode: string;
    message: string;
  }): Promise<void> {
    const approvalUrl = buildApprovalDetailUrl(input.instanceCode, this.config.FEISHU_APPROVAL_DETAIL_URL_TEMPLATE);

    await this.feishuClient.sendInteractiveCard({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      card: {
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
      },
    });
  }

  async sendOriginalFileSaved(input: {
    serialNumber?: string | null;
    instanceCode: string;
    fileName: string;
    storageKey?: string | null;
  }): Promise<void> {
    const approvalUrl = buildApprovalDetailUrl(input.instanceCode, this.config.FEISHU_APPROVAL_DETAIL_URL_TEMPLATE);

    await this.feishuClient.sendInteractiveCard({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      card: {
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
      },
    });
  }
}

const formatAmountMatched = (value: boolean | null): string => {
  if (value === true) return "✅ 一致";
  if (value === false) return "❌ 不一致";
  return "⚠️ 无法判断";
};

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
