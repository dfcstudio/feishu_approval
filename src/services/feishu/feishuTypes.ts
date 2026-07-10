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
  form: unknown;
  raw: unknown;
}
