import type { PrismaClient, RiskLevel } from "@prisma/client";
import type { AppEnv } from "../../config/env.js";
import type { ApprovalApprover } from "../feishu/feishuTypes.js";

export type RecipientRole = "APPLICANT" | "CURRENT_APPROVER" | "FINANCE" | "RISK_OWNER" | "FIXED_GROUP";
export interface NotificationRecipient { receiveIdType: "open_id" | "user_id" | "chat_id"; receiveId: string; role: RecipientRole; }
export interface RoutingInput { riskLevel: RiskLevel; applicantId?: string | null; departmentIds: string[]; currentApprovers: ApprovalApprover[]; extraRecipientOpenIds?: string[]; }
const riskRank: Record<RiskLevel, number> = { LOW: 0, UNKNOWN: 1, MEDIUM: 2, HIGH: 3 };
const roleRank: Record<RecipientRole, number> = { APPLICANT: 0, CURRENT_APPROVER: 1, FIXED_GROUP: 2, FINANCE: 3, RISK_OWNER: 4 };

export class NotificationRouter {
  constructor(private readonly db: PrismaClient | undefined, private readonly config: Pick<AppEnv, "FEISHU_NOTIFY_RECEIVE_ID_TYPE" | "FEISHU_NOTIFY_RECEIVE_ID">) {}
  async resolve(input: RoutingInput): Promise<NotificationRecipient[]> {
    const recipients = new Map<string, NotificationRecipient>();
    const add = (r?: NotificationRecipient) => { if (!r?.receiveId) return; const key = `${r.receiveIdType}:${r.receiveId}`; const old = recipients.get(key); if (!old || roleRank[r.role] > roleRank[old.role]) recipients.set(key, r); };
    add({ receiveIdType: this.config.FEISHU_NOTIFY_RECEIVE_ID_TYPE, receiveId: this.config.FEISHU_NOTIFY_RECEIVE_ID, role: "FIXED_GROUP" });
    input.extraRecipientOpenIds?.forEach((receiveId) => add({ receiveIdType: "open_id", receiveId, role: "CURRENT_APPROVER" }));
    input.currentApprovers.forEach((a) => add(a.openId ? { receiveIdType: "open_id", receiveId: a.openId, role: "CURRENT_APPROVER" } : a.userId ? { receiveIdType: "user_id", receiveId: a.userId, role: "CURRENT_APPROVER" } : undefined));
    if (input.riskLevel !== "LOW" && input.applicantId) add({ receiveIdType: input.applicantId.startsWith("ou_") ? "open_id" : "user_id", receiveId: input.applicantId, role: "APPLICANT" });
    if (!this.db) return [...recipients.values()];
    const rules = await this.db.notificationRule.findMany({ where: { enabled: true }, orderBy: { priority: "desc" } });
    for (const rule of rules) {
      if (riskRank[input.riskLevel] < riskRank[rule.minRiskLevel]) continue;
      if (rule.departmentId && !input.departmentIds.includes(rule.departmentId)) continue;
      const role = normalizeRole(rule.recipientRole);
      if (rule.receiveId && rule.receiveIdType) add({ receiveIdType: normalizeIdType(rule.receiveIdType), receiveId: rule.receiveId, role });
      if (rule.notifyApplicant && input.applicantId) add({ receiveIdType: input.applicantId.startsWith("ou_") ? "open_id" : "user_id", receiveId: input.applicantId, role: "APPLICANT" });
      if (rule.notifyCurrentApprovers) input.currentApprovers.forEach((a) => add(a.openId ? { receiveIdType: "open_id", receiveId: a.openId, role: "CURRENT_APPROVER" } : a.userId ? { receiveIdType: "user_id", receiveId: a.userId, role: "CURRENT_APPROVER" } : undefined));
      const owners = input.departmentIds.length ? await this.db.departmentNotificationOwner.findMany({ where: { departmentId: { in: input.departmentIds }, role: rule.recipientRole } }) : [];
      owners.forEach((o) => add({ receiveIdType: normalizeIdType(o.receiveIdType), receiveId: o.receiveId, role }));
    }
    return [...recipients.values()];
  }
}
const normalizeIdType = (v: string): NotificationRecipient["receiveIdType"] => v === "open_id" || v === "user_id" ? v : "chat_id";
const normalizeRole = (v: string): RecipientRole => (["APPLICANT", "CURRENT_APPROVER", "FINANCE", "RISK_OWNER", "FIXED_GROUP"] as string[]).includes(v) ? v as RecipientRole : "FINANCE";
