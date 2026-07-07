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

    return {
      instanceCode:
        firstString(instance, ["instance_code", "instanceCode", "code"]) ?? instanceCode,
      approvalName: firstString(instance, ["approval_name", "approvalName", "name", "title"]),
      applicantId: firstString(instance, ["user_id", "applicant_id", "applicantId", "open_id"]),
      applicantName: firstString(instance, ["user_name", "applicant_name", "applicantName"]),
      form: instance.form ?? instance.form_value ?? instance.formValue ?? [],
      raw: instance,
    };
  }

  async downloadApprovalFile(attachment: NormalizedAttachment): Promise<Buffer> {
    const token = await this.getTenantAccessToken();
    const fileToken = encodeURIComponent(attachment.fileToken);

    const candidates = [
      `/open-apis/approval/v4/files/${fileToken}/download`,
      `/open-apis/drive/v1/medias/${fileToken}/download`,
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
}

const firstString = (record: UnknownRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};
