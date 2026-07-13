import axios, { type AxiosInstance } from "axios";
import type { AppEnv } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";
import { retry } from "../../utils/retry.js";
import type {
  FeishuApprovalInstanceDetail,
  NormalizedAttachment,
  UnknownRecord,
} from "./feishuTypes.js";

interface TenantTokenCache {
  token: string;
  expiresAt: number;
}

export class FeishuClient {
  private readonly http: AxiosInstance;
  private tokenCache?: TenantTokenCache;

  constructor(private readonly config: AppEnv) {
    this.http = axios.create({
      baseURL: config.FEISHU_API_BASE_URL,
      timeout: 15000,
    });
  }

  async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }

    if (!this.config.FEISHU_APP_ID || !this.config.FEISHU_APP_SECRET) {
      throw new AppError("Feishu app credentials are not configured", "FEISHU_CONFIG_MISSING");
    }

    const response = await retry(
      () =>
        this.http.post("/open-apis/auth/v3/tenant_access_token/internal", {
          app_id: this.config.FEISHU_APP_ID,
          app_secret: this.config.FEISHU_APP_SECRET,
        }),
      { attempts: 3, delayMs: 500 },
    );

    const data = response.data as UnknownRecord;
    if (data.code !== 0 || typeof data.tenant_access_token !== "string") {
      throw new AppError("Failed to get Feishu tenant access token", "FEISHU_TOKEN_FAILED", 502, {
        code: data.code,
        msg: data.msg,
      });
    }

    this.tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + Number(data.expire ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }

  async getApprovalInstanceDetail(instanceCode: string): Promise<FeishuApprovalInstanceDetail> {
    const token = await this.getTenantAccessToken();
    const response = await retry(
      () =>
        this.http.get(`/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      { attempts: 3, delayMs: 500 },
    );

    const data = response.data as UnknownRecord;
    if (data.code !== 0) {
      throw new AppError("Failed to fetch approval instance detail", "FEISHU_APPROVAL_GET_FAILED", 502, {
        code: data.code,
        msg: data.msg,
      });
    }

    const instance = ((data.data as UnknownRecord | undefined)?.instance ??
      data.data ??
      data) as UnknownRecord;
    const applicantId = firstString(instance, ["user_id", "applicant_id", "applicantId", "open_id"]);
    const taskList = instance.task_list ?? instance.taskList;
    const approverOpenIds = Array.isArray(taskList)
      ? [...new Set(taskList.flatMap((task) => {
          if (!task || typeof task !== "object") return [];
          const taskRecord = task as UnknownRecord;
          const status = firstString(taskRecord, ["status", "task_status", "taskStatus"]);
          if (!status || !["PENDING", "TODO", "WAITING"].includes(status.toUpperCase())) return [];
          const openId = firstString(taskRecord, ["open_id", "openId"]);
          return openId ? [openId] : [];
        }))]
      : [];
    const currentApprovers = extractCurrentApprovers(instance);
    let applicantDepartmentIds = extractStringArray(instance, ["department_ids", "departmentIds", "department_id", "departmentId"]);
    if (!applicantDepartmentIds.length && applicantId) applicantDepartmentIds = await this.getUserDepartmentIds(applicantId);

    return {
      instanceCode:
        firstString(instance, ["instance_code", "instanceCode", "code"]) ?? instanceCode,
      serialNumber: firstString(instance, ["serial_number", "serialNumber", "serial_id"]),
      approvalCode: firstString(instance, ["approval_code", "approvalCode"]),
      approvalName: firstString(instance, ["approval_name", "approvalName", "name", "title"]),
      applicantId,
      applicantName:
        firstString(instance, ["user_name", "applicant_name", "applicantName"]) ??
        firstString(instance, ["user_id", "applicant_id", "applicantId"]),
      submitterOpenId:
        firstString(instance, ["open_id", "openId"]) ??
        (applicantId?.startsWith("ou_") ? applicantId : undefined),
      approverOpenIds,
      currentApprovers,
      applicantDepartmentIds,
      form: instance.form ?? instance.form_value ?? instance.formValue ?? [],
      raw: instance,
    };
  }

  async resolveUserName(userId: string): Promise<string | undefined> {
    const mappedName = this.config.APPLICANT_NAME_MAP[userId];
    if (mappedName) return mappedName;

    const token = await this.getTenantAccessToken();
    const idTypes = ["open_id", "user_id"] as const;
    for (const userIdType of idTypes) {
      try {
        const response = await retry(
          () =>
            this.http.get(
              `/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=${userIdType}`,
              { headers: { Authorization: `Bearer ${token}` } },
            ),
          { attempts: 2, delayMs: 500 },
        );
        const data = response.data as UnknownRecord;
        if (data.code !== 0) continue;
        const user = ((data.data as UnknownRecord | undefined)?.user ?? data.data ?? data) as UnknownRecord;
        const name = firstString(user, ["name", "cn_name", "en_name", "nickname", "display_name"]);
        if (name) return name;
      } catch {
        // User lookup is a best-effort display enhancement. Approval audit must not fail on it.
      }
    }

    return undefined;
  }

  private async getUserDepartmentIds(userId: string): Promise<string[]> {
    try {
      const token = await this.getTenantAccessToken();
      const userIdType = userId.startsWith("ou_") ? "open_id" : "user_id";
      const response = await this.http.get(`/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, {
        params: { user_id_type: userIdType }, headers: { Authorization: `Bearer ${token}` },
      });
      const data = response.data as UnknownRecord;
      const user = ((data.data as UnknownRecord | undefined)?.user ?? data.data ?? {}) as UnknownRecord;
      return extractStringArray(user, ["department_ids", "departmentIds"]);
    } catch { return []; }
  }

  async downloadApprovalFile(attachment: NormalizedAttachment): Promise<Buffer> {
    const fileToken = attachment.fileToken;

    if (/^https?:\/\//i.test(fileToken)) {
      const fileUrl = validateDirectFileDownloadUrl(fileToken, this.config);
      let response;
      try {
        response = await retry(
          () =>
            this.http.get<ArrayBuffer>(fileUrl.toString(), {
              responseType: "arraybuffer",
              timeout: 30000,
              maxContentLength: this.config.FEISHU_FILE_DOWNLOAD_MAX_BYTES,
              maxBodyLength: this.config.FEISHU_FILE_DOWNLOAD_MAX_BYTES,
            }),
          { attempts: 2, delayMs: 500 },
        );
      } catch (error) {
        throw new AppError(
          `Failed to download Feishu approval attachment from ${fileUrl.hostname}${httpStatusSuffix(error)}`,
          "FEISHU_FILE_DOWNLOAD_FAILED",
          502,
          {
            host: fileUrl.hostname,
            upstreamStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
          },
        );
      }
      assertDownloadSize(response.headers as Record<string, unknown>, this.config.FEISHU_FILE_DOWNLOAD_MAX_BYTES);
      const buffer = Buffer.from(response.data);
      if (buffer.byteLength > this.config.FEISHU_FILE_DOWNLOAD_MAX_BYTES) {
        throw new AppError("Feishu approval attachment is too large", "FEISHU_FILE_TOO_LARGE", 413, {
          maxBytes: this.config.FEISHU_FILE_DOWNLOAD_MAX_BYTES,
          actualBytes: buffer.byteLength,
        });
      }
      return buffer;
    }

    const token = await this.getTenantAccessToken();
    const encodedFileToken = encodeURIComponent(fileToken);

    const candidates = [
      `/open-apis/approval/v4/files/${encodedFileToken}/download`,
      `/open-apis/drive/v1/medias/${encodedFileToken}/download`,
    ];

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const response = await retry(
          () =>
            this.http.get<ArrayBuffer>(url, {
              headers: { Authorization: `Bearer ${token}` },
              responseType: "arraybuffer",
            }),
          { attempts: 2, delayMs: 500 },
        );
        return Buffer.from(response.data);
      } catch (error) {
        lastError = error;
      }
    }

    throw new AppError("Failed to download Feishu approval attachment", "FEISHU_FILE_DOWNLOAD_FAILED", 502, {
      fileToken: attachment.fileToken,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  async sendBotTextMessage(input: {
    receiveIdType: "open_id" | "user_id" | "chat_id";
    receiveId: string;
    text: string;
  }): Promise<void> {
    if (!input.receiveId) return;
    const token = await this.getTenantAccessToken();
    const response = await retry(
      () =>
        this.http.post(
          `/open-apis/im/v1/messages?receive_id_type=${input.receiveIdType}`,
          {
            receive_id: input.receiveId,
            msg_type: "text",
            content: JSON.stringify({ text: input.text }),
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      { attempts: 3, delayMs: 500 },
    );

    const data = response.data as UnknownRecord;
    if (data.code !== 0) {
      throw new AppError("Failed to send Feishu bot message", "FEISHU_MESSAGE_SEND_FAILED", 502, {
        code: data.code,
        msg: data.msg,
      });
    }
  }

  async sendInteractiveCard(input: {
    receiveIdType: "open_id" | "user_id" | "chat_id";
    receiveId: string;
    card: Record<string, unknown>;
  }): Promise<void> {
    if (!input.receiveId) return;
    const token = await this.getTenantAccessToken();
    const response = await retry(
      () =>
        this.http.post(
          `/open-apis/im/v1/messages?receive_id_type=${input.receiveIdType}`,
          {
            receive_id: input.receiveId,
            msg_type: "interactive",
            content: JSON.stringify(input.card),
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      { attempts: 3, delayMs: 500 },
    );

    const data = response.data as UnknownRecord;
    if (data.code !== 0) {
      throw new AppError("Failed to send Feishu interactive card", "FEISHU_MESSAGE_SEND_FAILED", 502, {
        code: data.code,
        msg: data.msg,
      });
    }
  }
}

const firstString = (record: UnknownRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const extractStringArray = (record: UnknownRecord, keys: string[]): string[] => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return [];
};

export const extractCurrentApprovers = (instance: UnknownRecord) => {
  const tasks = instance.task_list ?? instance.taskList ?? instance.tasks ?? [];
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const task = raw as UnknownRecord;
    const status = firstString(task, ["status", "task_status", "taskStatus"])?.toUpperCase();
    if (status && !["PENDING", "TODO", "WAITING", "RUNNING", "PROCESSING", "ACTIVE"].includes(status)) return [];
    const openId = firstString(task, ["open_id", "openId", "approver_open_id", "approverOpenId"]);
    const userId = firstString(task, ["user_id", "userId", "approver_id", "approverId"]);
    if (!openId && !userId) return [];
    return [{ openId, userId, name: firstString(task, ["user_name", "userName", "name", "approver_name"]) }];
  });
};

export const validateDirectFileDownloadUrl = (
  rawUrl: string,
  config: Pick<AppEnv, "FEISHU_API_BASE_URL" | "FEISHU_FILE_DOWNLOAD_ALLOWED_HOSTS">,
): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("Invalid Feishu approval attachment URL", "FEISHU_FILE_DOWNLOAD_URL_INVALID", 400);
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("Forbidden Feishu approval attachment URL", "FEISHU_FILE_DOWNLOAD_URL_FORBIDDEN", 400, {
      protocol: url.protocol,
      host: url.hostname,
    });
  }

  const apiHost = new URL(config.FEISHU_API_BASE_URL).hostname;
  const allowedHosts = [...config.FEISHU_FILE_DOWNLOAD_ALLOWED_HOSTS, apiHost];
  if (!isAllowedDownloadHost(url.hostname, allowedHosts)) {
    throw new AppError(
      `Forbidden Feishu approval attachment host: ${url.hostname}`,
      "FEISHU_FILE_DOWNLOAD_HOST_FORBIDDEN",
      403,
      { host: url.hostname },
    );
  }

  return url;
};

export const isAllowedDownloadHost = (hostname: string, allowedHosts: string[]): boolean => {
  const host = normalizeHost(hostname);
  return allowedHosts.some((allowedHost) => {
    const pattern = normalizeHost(allowedHost);
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host !== suffix && host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
};

const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");

const httpStatusSuffix = (error: unknown): string => {
  if (!axios.isAxiosError(error) || !error.response?.status) return "";
  return ` (HTTP ${error.response.status})`;
};

const assertDownloadSize = (headers: Record<string, unknown>, maxBytes: number): void => {
  const value = headers["content-length"];
  const contentLength = Array.isArray(value) ? value[0] : value;
  const size = typeof contentLength === "string" ? Number(contentLength) : undefined;
  if (size !== undefined && Number.isFinite(size) && size > maxBytes) {
    throw new AppError("Feishu approval attachment is too large", "FEISHU_FILE_TOO_LARGE", 413, {
      maxBytes,
      contentLength: size,
    });
  }
};
