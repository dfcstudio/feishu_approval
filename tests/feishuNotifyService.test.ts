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
