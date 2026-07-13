import { describe, expect, it } from "vitest";
import { summarizeStoredEvidences } from "../src/services/approval/ApprovalAuditService.js";
const doc = (documentType: "PAYMENT" | "INVOICE", ocrAmount?: string) => ({ documentType, ocrAmount, riskLevel: (ocrAmount ? "LOW" : "UNKNOWN") as "LOW" | "UNKNOWN", riskReasons: ocrAmount ? [] : ["OCR_AMOUNT_NOT_FOUND"] });
describe("multi-document summary", () => {
  it("sums payments and invoices separately", () => {
    const result = summarizeStoredEvidences("300.00", [doc("PAYMENT", "100.00"), doc("PAYMENT", "200.00"), doc("INVOICE", "120.00"), doc("INVOICE", "180.00")]);
    expect(result.paymentTotal).toBe("300.00"); expect(result.invoiceTotal).toBe("300.00");
    expect(result.paymentTotalMatched).toBe(true); expect(result.invoiceTotalMatched).toBe(true);
  });
  it("flags incomplete and mismatched categories", () => {
    const result = summarizeStoredEvidences("300.00", [doc("PAYMENT", "290.00"), doc("INVOICE")]);
    expect(result.riskReasons).toEqual(expect.arrayContaining(["PAYMENT_TOTAL_MISMATCH", "INVOICE_AMOUNT_INCOMPLETE"]));
    expect(result.riskLevel).toBe("MEDIUM");
  });
});
