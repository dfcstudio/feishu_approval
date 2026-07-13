import { describe, expect, it } from "vitest";
import { validateDirectFileDownloadUrl } from "../src/services/feishu/FeishuClient.js";

const downloadConfig = {
  FEISHU_API_BASE_URL: "https://open.feishu.cn",
  FEISHU_FILE_DOWNLOAD_ALLOWED_HOSTS: ["open.feishu.cn", "*.feishu.cn", "*.feishucdn.com"],
};

describe("FeishuClient direct file download URL validation", () => {
  it("allows HTTPS URLs from configured Feishu hosts", () => {
    const url = validateDirectFileDownloadUrl("https://files.feishu.cn/evidence.png", downloadConfig);

    expect(url.hostname).toBe("files.feishu.cn");
  });

  it("allows HTTPS URLs from the Feishu attachment CDN", () => {
    const url = validateDirectFileDownloadUrl(
      "https://s3-imfile.feishucdn.com/static-resource/v1/evidence.png",
      downloadConfig,
    );

    expect(url.hostname).toBe("s3-imfile.feishucdn.com");
  });

  it("rejects non-HTTPS URLs", () => {
    expect(() => validateDirectFileDownloadUrl("http://files.feishu.cn/evidence.png", downloadConfig)).toThrow(
      "Forbidden Feishu approval attachment URL",
    );
  });

  it("rejects hosts outside the allowlist", () => {
    expect(() => validateDirectFileDownloadUrl("https://example.com/evidence.png", downloadConfig)).toThrow(
      "Forbidden Feishu approval attachment host: example.com",
    );
  });
});
