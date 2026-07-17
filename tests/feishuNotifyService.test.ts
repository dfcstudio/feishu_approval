import { describe, expect, it, vi } from "vitest";
import { FeishuNotifyService, buildApprovalDetailUrl } from "../src/services/notify/FeishuNotifyService.js";

describe("buildApprovalDetailUrl", () => {
  it("replaces instanceCode placeholders with URL encoding", () => {
    expect(buildApprovalDetailUrl(
      "inst/1",
      "https://applink.feishu.cn/client/mini_program/open?path=pc%2Fpages%2Fin-process%2Findex%3FinstanceId%3D{instanceCode}",
    )).toBe(
      "https://applink.feishu.cn/client/mini_program/open?path=pc%2Fpages%2Fin-process%2Findex%3FinstanceId%3Dinst%2F1",
    );
  });

  it("appends instance_code when the template has no placeholder", () => {
    expect(buildApprovalDetailUrl("inst_1", "https://app.feishu.cn/approval/detail")).toBe(
      "https://app.feishu.cn/approval/detail?instance_code=inst_1",
    );
  });

  it("supports templates ending with an explicit query parameter", () => {
    expect(buildApprovalDetailUrl("inst_1", "https://app.feishu.cn/approval/detail?instance_code=")).toBe(
      "https://app.feishu.cn/approval/detail?instance_code=inst_1",
    );
  });
});

describe("FeishuNotifyService recipients", () => {
  it("renders applicant and risk information in Chinese without exposing an applicant id as a name", async () => {
    const feishuClient = { sendInteractiveCard: vi.fn().mockResolvedValue(undefined) };
    const service = new FeishuNotifyService(feishuClient as never, {
      FEISHU_NOTIFY_RECEIVE_ID_TYPE: "open_id",
      FEISHU_NOTIFY_RECEIVE_ID: "ou_configured",
      FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: "https://app.feishu.cn/approval/detail?instance_code=",
    });

    await service.sendAuditResult({
      instanceCode: "inst_zh",
      applicantId: "7b8afdbb",
      applicantName: "7b8afdbb",
      approvalAmount: "389.44",
      amountMatched: false,
      riskLevel: "MEDIUM",
      riskReasons: ["PAYMENT_TOTAL_MISMATCH"],
      duplicateMatches: [],
    });

    const card = feishuClient.sendInteractiveCard.mock.calls[0][0].card as {
      elements: Array<{ text?: { content?: string } }>;
    };
    const content = card.elements.flatMap((element) => element.text?.content ?? []).join("\n");
    expect(content).toContain("报销人：**7b8afdbb（未识别姓名）");
    expect(content).toContain("风险等级：**🟡 中风险");
    expect(content).toContain("风险原因：**付款凭证合计与费用明细合计不一致");
  });

  it("sends the card once to each additional open_id", async () => {
    const feishuClient = { sendInteractiveCard: vi.fn().mockResolvedValue(undefined) };
    const service = new FeishuNotifyService(feishuClient as never, {
      FEISHU_NOTIFY_RECEIVE_ID_TYPE: "open_id",
      FEISHU_NOTIFY_RECEIVE_ID: "ou_configured",
      FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: "https://app.feishu.cn/approval/detail?instance_code=",
    });

    await service.sendAuditResult({
      instanceCode: "inst_1",
      approvalAmount: "10.00",
      amountMatched: true,
      riskLevel: "LOW",
      riskReasons: [],
      duplicateMatches: [],
      extraRecipientOpenIds: ["ou_submitter", "ou_approver", "ou_submitter", "ou_configured"],
    });

    expect(feishuClient.sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(feishuClient.sendInteractiveCard).toHaveBeenCalledWith(expect.objectContaining({
      receiveIdType: "open_id",
      receiveId: "ou_submitter",
    }));
    expect(feishuClient.sendInteractiveCard).toHaveBeenCalledWith(expect.objectContaining({
      receiveIdType: "open_id",
      receiveId: "ou_approver",
    }));
  });
});
