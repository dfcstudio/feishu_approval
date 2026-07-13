import type { AppEnv } from "../../config/env.js";
import { BusinessError } from "../../utils/errors.js";
import { normalizeMoney } from "../../utils/money.js";
import type {
  FeishuApprovalInstanceDetail,
  NormalizedAttachment,
  ParsedApprovalForm,
  UnknownRecord,
} from "../feishu/feishuTypes.js";

interface FormField {
  name: string;
  value: unknown;
  raw: unknown;
}

export const parseApprovalForm = (
  detail: FeishuApprovalInstanceDetail,
  config: Pick<
    AppEnv,
    | "APPROVAL_AMOUNT_FIELD_NAMES"
    | "APPROVAL_ATTACHMENT_FIELD_NAMES"
    | "APPROVAL_INVOICE_FIELD_NAMES"
    | "APPROVAL_APPLICANT_FIELD_NAMES"
    | "APPROVAL_HANDLER_FIELD_NAMES"
  >,
): ParsedApprovalForm => {
  const fields = normalizeFormFields(detail.form);
  const amountField = findByNames(fields, config.APPROVAL_AMOUNT_FIELD_NAMES);
  const paymentFields = findAllByNames(fields, config.APPROVAL_ATTACHMENT_FIELD_NAMES);
  const invoiceFields = findAllByNames(fields, config.APPROVAL_INVOICE_FIELD_NAMES);
  const applicantField = findByNames(fields, config.APPROVAL_APPLICANT_FIELD_NAMES);
  const handlerField = findByNames(fields, config.APPROVAL_HANDLER_FIELD_NAMES);

  if (!amountField) {
    throw new BusinessError("Cannot parse approval amount field", "APPROVAL_AMOUNT_FIELD_NOT_FOUND", {
      configuredNames: config.APPROVAL_AMOUNT_FIELD_NAMES,
      availableFields: fields.map((field) => field.name),
    });
  }

  const byToken = new Map<string, NormalizedAttachment>();
  for (const field of paymentFields) for (const item of normalizeAttachments(field.value, "PAYMENT")) byToken.set(item.fileToken, item);
  for (const field of invoiceFields) for (const item of normalizeAttachments(field.value, "INVOICE")) byToken.set(item.fileToken, item);
  const attachments = [...byToken.values()];
  if (attachments.length === 0) {
    throw new BusinessError("Cannot parse payment evidence attachments", "APPROVAL_ATTACHMENT_FIELD_NOT_FOUND", {
      configuredNames: config.APPROVAL_ATTACHMENT_FIELD_NAMES,
      availableFields: fields.map((field) => field.name),
    });
  }

  const applicant = parseApplicant(applicantField?.value);

  return {
    instanceCode: detail.instanceCode,
    serialNumber: detail.serialNumber,
    approvalCode: detail.approvalCode,
    approvalName: detail.approvalName,
    applicantId: applicant.id ?? detail.applicantId,
    applicantName: applicant.name ?? detail.applicantName,
    approvalAmount: normalizeMoney(unwrapMoneyValue(amountField.value)),
    attachments,
    handlerOpenIds: parsePersonOpenIds(handlerField?.value),
    applicantDepartmentIds: detail.applicantDepartmentIds ?? [],
    currentApprovers: detail.currentApprovers ?? [],
  };
};

const parsePersonOpenIds = (input: unknown): string[] => {
  const openIds = new Set<string>();
  const visit = (value: unknown): void => {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) {
      parsed.forEach(visit);
      return;
    }
    if (!isRecord(parsed)) return;

    const openId = firstString(parsed, ["open_id", "openId"]);
    if (openId) openIds.add(openId);
    for (const key of ["value", "values", "user", "users", "member", "members"]) {
      if (parsed[key] !== undefined) visit(parsed[key]);
    }
  };
  visit(input);
  return [...openIds];
};

export const normalizeFormFields = (input: unknown): FormField[] => {
  const parsed = parseMaybeJson(input);
  const nodes = Array.isArray(parsed) ? parsed : [parsed];
  return nodes.flatMap((node) => normalizeFieldNode(node));
};

const normalizeFieldNode = (node: unknown): FormField[] => {
  const parsed = parseMaybeJson(node);
  if (!isRecord(parsed)) return [];

  const nested = parsed.children ?? parsed.items ?? parsed.value_list ?? parsed.valueList;
  const nestedFields = Array.isArray(nested) ? nested.flatMap((child) => normalizeFieldNode(child)) : [];
  const valueRows = Array.isArray(parsed.value)
    ? parsed.value.flatMap((row: unknown) =>
        Array.isArray(row) ? row.flatMap((item: unknown) => normalizeFieldNode(item)) : [],
      )
    : [];

  const name = firstString(parsed, [
    "name",
    "field_name",
    "fieldName",
    "title",
    "label",
    "custom_id",
    "customId",
  ]);

  if (!name) return [...nestedFields, ...valueRows];

  const value =
    parsed.value ??
    parsed.field_value ??
    parsed.fieldValue ??
    parsed.values ??
    parsed.option ??
    parsed;

  return [{ name, value: parseMaybeJson(value), raw: parsed }, ...nestedFields, ...valueRows];
};

const normalizeAttachments = (input: unknown, documentType: NormalizedAttachment["documentType"]): NormalizedAttachment[] => {
  const parsed = parseMaybeJson(input);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.flatMap((candidate) => extractAttachmentCandidates(candidate, documentType));
};

const extractAttachmentCandidates = (input: unknown, documentType: NormalizedAttachment["documentType"]): NormalizedAttachment[] => {
  const parsed = parseMaybeJson(input);
  if (typeof parsed === "string" && parsed.trim()) {
    return [{ fileToken: parsed.trim(), name: undefined, mimeType: undefined, size: undefined, raw: parsed, documentType }];
  }
  if (!isRecord(parsed)) return [];

  const token = firstString(parsed, [
    "file_token",
    "fileToken",
    "token",
    "attachment_token",
    "attachmentToken",
    "media_id",
    "mediaId",
    "url",
  ]);

  const nested = [
    parsed.file,
    parsed.files,
    parsed.attachment,
    parsed.attachments,
    parsed.value,
    parsed.values,
  ].flatMap((value) => {
    const normalized = parseMaybeJson(value);
    return Array.isArray(normalized) ? normalized : normalized ? [normalized] : [];
  });

  const current = token
    ? [
        {
          fileToken: token,
          name: firstString(parsed, ["name", "file_name", "fileName"]),
          mimeType: firstString(parsed, ["mime_type", "mimeType", "type"]),
          size: firstNumber(parsed, ["size", "file_size", "fileSize"]),
          raw: parsed,
          documentType,
        },
      ]
    : [];

  return [...current, ...nested.flatMap((item) => extractAttachmentCandidates(item, documentType))];
};

const parseApplicant = (input: unknown): { id?: string; name?: string } => {
  const parsed = parseMaybeJson(input);
  if (typeof parsed === "string") return { name: parsed };
  if (!isRecord(parsed)) return {};
  return {
    id: firstString(parsed, ["id", "user_id", "userId", "open_id", "openId"]),
    name: firstString(parsed, ["name", "user_name", "userName", "display_name", "displayName"]),
  };
};

const findByNames = (fields: FormField[], names: string[]): FormField | undefined => {
  const normalizedNames = names.map((name) => name.trim().toLowerCase());
  return fields.find((field) => normalizedNames.includes(field.name.trim().toLowerCase()));
};

const findAllByNames = (fields: FormField[], names: string[]): FormField[] => {
  const normalizedNames = names.map((name) => name.trim().toLowerCase());
  return fields.filter((field) => normalizedNames.includes(field.name.trim().toLowerCase()));
};

const unwrapMoneyValue = (input: unknown): unknown => {
  const parsed = parseMaybeJson(input);
  if (!isRecord(parsed)) return parsed;
  for (const key of ["amount", "total", "total_amount", "totalAmount", "value", "text"]) {
    if (parsed[key] !== undefined) return unwrapMoneyValue(parsed[key]);
  }
  return parsed;
};

const parseMaybeJson = (input: unknown): unknown => {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return input;
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstString = (record: UnknownRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const firstNumber = (record: UnknownRecord, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};
