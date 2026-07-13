export type UnknownRecord = Record<string, unknown>;

export interface FeishuApprovalEvent {
  instanceCode: string;
  status?: string;
  raw: UnknownRecord;
}

export interface NormalizedAttachment {
  fileToken: string;
  name?: string;
  mimeType?: string;
  size?: number;
  raw: unknown;
  documentType: "PAYMENT" | "INVOICE";
}

export interface ParsedApprovalForm {
  instanceCode: string;
  serialNumber?: string;
  approvalCode?: string;
  approvalName?: string | null;
  applicantId?: string | null;
  applicantName?: string | null;
  approvalAmount: string;
  attachments: NormalizedAttachment[];
  handlerOpenIds: string[];
  applicantDepartmentIds: string[];
  currentApprovers: ApprovalApprover[];
}

export interface FeishuApprovalInstanceDetail {
  instanceCode: string;
  serialNumber?: string;
  approvalCode?: string;
  approvalName?: string | null;
  applicantId?: string | null;
  applicantName?: string | null;
  submitterOpenId?: string;
  approverOpenIds?: string[];
  applicantDepartmentIds?: string[];
  currentApprovers?: ApprovalApprover[];
  form: unknown;
  raw: unknown;
}

export interface ApprovalApprover {
  openId?: string;
  userId?: string;
  name?: string;
}
