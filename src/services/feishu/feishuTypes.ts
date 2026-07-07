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
  approvalName?: string;
  applicantId?: string;
  applicantName?: string;
  approvalAmount: string;
  attachments: NormalizedAttachment[];
}

export interface FeishuApprovalInstanceDetail {
  instanceCode: string;
  approvalName?: string;
  applicantId?: string;
  applicantName?: string;
  form: unknown;
  raw: unknown;
}
