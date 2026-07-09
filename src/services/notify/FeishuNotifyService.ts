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
    private readonly config: Pick<AppEnv, "FEISHU_NOTIFY_RECEIVE_ID_TYPE" | "FEISHU_NOTIFY_RECEIVE_ID">,
  ) {}

  async sendAuditResult(input: AuditNotificationInput): Promise<void> {
    const approvalUrl = `https://www.feishu.cn/approval/detail/${encodeURIComponent(input.instanceCode)}`;
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
      const duplicateLines = input.duplicateMatches.map((match) => {
        const evidence = match.matchedEvidence;
        return [
          `**${match.matchType}** score: ${match.score.toFixed(2)}`,
          `历史实例: ${evidence.instanceCode}`,
          `历史报销人: ${evidence.applicantName ?? "未知"}`,
          `历史金额: ${String(evidence.approvalAmount ?? "未知")}`,
          `提交时间: ${formatValue(evidence.createdAt)}`,
        ].join(" / ");
      });

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

    await this.feishuClient.sendInteractiveCard({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: `报销辅助审核 ${riskEmoji(input.riskLevel)}` },
          template: RISK_COLORS[input.riskLevel] ?? "grey",
        },
        elements,
      },
    });
  }

  async sendManualReviewWarning(input: {
    serialNumber?: string | null;
    instanceCode: string;
    errorCode: string;
    message: string;
  }): Promise<void> {
    const approvalUrl = `https://www.feishu.cn/approval/detail/${encodeURIComponent(input.instanceCode)}`;

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
    const approvalUrl = `https://www.feishu.cn/approval/detail/${encodeURIComponent(input.instanceCode)}`;

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
  if (value instanceof Date) return value.toISOString();
  return String(value);
};
