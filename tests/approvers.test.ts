import { describe, expect, it } from "vitest";
import { extractCurrentApprovers } from "../src/services/feishu/FeishuClient.js";
describe("approval task parsing", () => {
  it("keeps only active approvers", () => {
    expect(extractCurrentApprovers({ task_list: [{ status: "PENDING", open_id: "ou_current" }, { status: "APPROVED", open_id: "ou_old" }] })).toEqual([{ openId: "ou_current", userId: undefined, name: undefined }]);
  });
});
