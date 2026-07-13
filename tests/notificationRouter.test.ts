import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { NotificationRouter } from "../src/services/notify/NotificationRouter.js";
const config = { FEISHU_NOTIFY_RECEIVE_ID_TYPE: "chat_id" as const, FEISHU_NOTIFY_RECEIVE_ID: "oc_finance" };
describe("NotificationRouter", () => {
  it("routes fixed group, current approvers and high-risk applicant without duplicates", async () => {
    const recipients = await new NotificationRouter(undefined, config).resolve({ riskLevel: "HIGH", applicantId: "ou_applicant", departmentIds: [], currentApprovers: [{ openId: "ou_approver" }], extraRecipientOpenIds: ["ou_approver"] });
    expect(recipients).toEqual(expect.arrayContaining([
      { receiveIdType: "chat_id", receiveId: "oc_finance", role: "FIXED_GROUP" },
      { receiveIdType: "open_id", receiveId: "ou_applicant", role: "APPLICANT" },
      { receiveIdType: "open_id", receiveId: "ou_approver", role: "CURRENT_APPROVER" },
    ]));
    expect(recipients.filter((item) => item.receiveId === "ou_approver")).toHaveLength(1);
  });
  it("applies department risk rules", async () => {
    const db = { notificationRule: { findMany: vi.fn().mockResolvedValue([{ departmentId: "dept_1", minRiskLevel: "MEDIUM", recipientRole: "FINANCE", receiveId: null, receiveIdType: null, notifyApplicant: false, notifyCurrentApprovers: false }]) }, departmentNotificationOwner: { findMany: vi.fn().mockResolvedValue([{ receiveIdType: "open_id", receiveId: "ou_owner" }]) } } as unknown as PrismaClient;
    const recipients = await new NotificationRouter(db, { ...config, FEISHU_NOTIFY_RECEIVE_ID: "" }).resolve({ riskLevel: "HIGH", departmentIds: ["dept_1"], currentApprovers: [] });
    expect(recipients).toContainEqual({ receiveIdType: "open_id", receiveId: "ou_owner", role: "FINANCE" });
  });
});
