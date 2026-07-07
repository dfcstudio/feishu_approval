import type { AppEnv } from "../../config/env.js";
import type { FeishuClient } from "../feishu/FeishuClient.js";
import type { DuplicateMatchResult } from "../dedupe/DedupeService.js";

export interface AuditNotificationInput {
  approvalName?: string | null;
  instanceCode: string;
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

export class FeishuNotifyService {
  constructor(
    private readonly feishuClient: FeishuClient,
    private readonly config: Pick<AppEnv, "FEISHU_NOTIFY_RECEIVE_ID_TYPE" | "FEISHU_NOTIFY_RECEIVE_ID">,
  ) {}

  async sendAuditResult(input: AuditNotificationInput): Promise<void> {
    const duplicateText =
      input.duplicateMatches.length === 0
        ? "未发现重复"
        : input.duplicateMatches
            .map((match) => {
              const evidence = match.matchedEvidence;
              return [
                `${match.matchType} score=${match.score.toFixed(2)}`,
                `历史审批实例 Code: ${evidence.instanceCode}`,
                `历史报销人: ${evidence.applicantName ?? "未知"}`,
                `历史金额: ${String(evidence.approvalAmount ?? "未知")}`,
                `历史提交时间: ${formatValue(evidence.createdAt)}`,
              ].join(" / ");
            })
            .join("\n");

    await this.feishuClient.sendBotTextMessage({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      text: [
        "报销辅助审核结果",
        `审批单：${input.approvalName ?? "未识别"}`,
        `审批实例 Code：${input.instanceCode}`,
        `报销人：${input.applicantName ?? "未识别"}`,
        `审批金额：${input.approvalAmount}`,
        `OCR 识别金额：${input.ocrAmount ?? "未识别"}`,
        `金额核对：${formatAmountMatched(input.amountMatched)}`,
        `交易号：${input.transactionId ?? "未识别"}`,
        `付款时间：${formatValue(input.paidAt)}`,
        `收款方：${input.payee ?? "未识别"}`,
        `查重结果：${input.duplicateMatches.length === 0 ? "未发现重复" : "发现疑似重复"}`,
        `风险等级：${input.riskLevel}`,
        `风险原因列表：${input.riskReasons.length ? input.riskReasons.join(", ") : "无"}`,
        "重复匹配明细：",
        duplicateText,
        "",
        "本结果由机器人基于 OCR 和历史凭证查重生成，仅供辅助审核。请审批人结合实际业务凭证人工判断。",
      ].join("\n"),
    });
  }

  async sendManualReviewWarning(input: {
    instanceCode: string;
    errorCode: string;
    message: string;
  }): Promise<void> {
    await this.feishuClient.sendBotTextMessage({
      receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE,
      receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID,
      text: [
        "报销辅助审核结果",
        `审批实例 Code：${input.instanceCode}`,
        `风险等级：UNKNOWN`,
        `风险原因列表：${input.errorCode}`,
        `需要人工处理：${input.message}`,
        "",
        "本结果由机器人基于 OCR 和历史凭证查重生成，仅供辅助审核。请审批人结合实际业务凭证人工判断。",
      ].join("\n"),
    });
  }
}

const formatAmountMatched = (value: boolean | null): string => {
  if (value === true) return "一致";
  if (value === false) return "不一致";
  return "无法判断";
};

const formatValue = (value: unknown): string => {
  if (!value) return "未识别";
  if (value instanceof Date) return value.toISOString();
  return String(value);
};
