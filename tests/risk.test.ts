import { describe, expect, it } from "vitest";
import { determineRisk } from "../src/services/approval/ApprovalAuditService.js";

describe("risk decision", () => {
  it("raises medium risk when OCR amount mismatches approval amount", () => {
    const risk = determineRisk({
      amountMatched: false,
      ocrAmount: "9.00",
      duplicateMatches: [],
    });

    expect(risk.riskLevel).toBe("MEDIUM");
    expect(risk.riskReasons).toContain("AMOUNT_MISMATCH");
  });
});
