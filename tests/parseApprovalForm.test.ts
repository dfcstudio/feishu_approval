import { describe, expect, it } from "vitest";
import { parseApprovalForm } from "../src/services/approval/parseApprovalForm.js";

describe("parseApprovalForm", () => {
  it("parses configured amount, applicant and attachment fields", () => {
    const parsed = parseApprovalForm(
      {
        instanceCode: "inst_1",
        serialNumber: "SN001",
        approvalName: "差旅报销",
        form: JSON.stringify([
          { name: "报销金额", value: "99.90" },
          { name: "付款凭证", value: [{ file_token: "file_1", name: "pay.png", mime_type: "image/png", size: 12 }] },
          { name: "报销人", value: { user_id: "u_1", name: "张三" } },
        ]),
        raw: {},
      },
      {
        APPROVAL_AMOUNT_FIELD_NAMES: ["报销金额", "金额"],
        APPROVAL_ATTACHMENT_FIELD_NAMES: ["付款凭证"],
        APPROVAL_APPLICANT_FIELD_NAMES: ["报销人"],
      },
    );

    expect(parsed.serialNumber).toBe("SN001");
    expect(parsed.approvalAmount).toBe("99.90");
    expect(parsed.applicantId).toBe("u_1");
    expect(parsed.applicantName).toBe("张三");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({
        fileToken: "file_1",
        name: "pay.png",
        mimeType: "image/png",
        size: 12,
      }),
    ]);
  });

  it("parses nested row fields and URL-only attachments", () => {
    const parsed = parseApprovalForm(
      {
        instanceCode: "inst_2",
        form: [
          {
            name: "明细",
            value: [
              [
                { name: "金额", value: "188.00" },
                { name: "图片/视频", value: "https://example.com/evidence.png" },
              ],
            ],
          },
        ],
        raw: {},
      },
      {
        APPROVAL_AMOUNT_FIELD_NAMES: ["金额"],
        APPROVAL_ATTACHMENT_FIELD_NAMES: ["图片/视频"],
        APPROVAL_APPLICANT_FIELD_NAMES: ["报销人"],
      },
    );

    expect(parsed.approvalAmount).toBe("188.00");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({
        fileToken: "https://example.com/evidence.png",
      }),
    ]);
  });
});
