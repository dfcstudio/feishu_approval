import { describe, expect, it } from "vitest";
import { classifyDocumentType, isSpreadsheetFile, summarizeStoredEvidences, toOcrConfidenceScore } from "../src/services/approval/ApprovalAuditService.js";
const doc = (documentType: "PAYMENT" | "INVOICE" | "SUPPORTING", ocrAmount?: string) => ({ documentType, ocrAmount, riskLevel: (ocrAmount ? "LOW" : "UNKNOWN") as "LOW" | "UNKNOWN", riskReasons: ocrAmount ? [] : ["OCR_AMOUNT_NOT_FOUND"] });
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
  it("keeps supporting material out of payment totals and risk", () => {
    const result = summarizeStoredEvidences("600.00", [doc("PAYMENT", "600.00"), doc("SUPPORTING", "600.00")]);
    expect(result.paymentTotal).toBe("600.00");
    expect(result.paymentTotalMatched).toBe(true);
    expect(result.supportingDocumentCount).toBe(1);
    expect(result.riskLevel).toBe("LOW");
  });
  it("marks an audit with only supporting material as high risk", () => {
    const result = summarizeStoredEvidences("600.00", [doc("SUPPORTING", "600.00")]);
    expect(result.riskLevel).toBe("HIGH");
    expect(result.riskReasons).toContain("VALID_EVIDENCE_NOT_FOUND");
  });
});

describe("OCR confidence score", () => {
  it.each([[0, 1], [0.2, 1], [0.21, 2], [0.6, 3], [0.81, 5], [1, 5]])(
    "maps %s to %s/5", (confidence, score) => expect(toOcrConfidenceScore(confidence)).toBe(score),
  );
});

describe("spreadsheet content detection", () => {
  it("detects an XLSX container even when Feishu omits filename and MIME type", () => {
    expect(isSpreadsheetFile(Buffer.from("PK\u0003\u0004...xl/workbook.xml..."))).toBe(true);
  });

  it("does not treat an ordinary image as a spreadsheet", () => {
    expect(isSpreadsheetFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });
});

describe("invoice content classification", () => {
  it("reclassifies a generic payment attachment when multiple invoice fields are present", () => {
    expect(classifyDocumentType("PAYMENT", "发票号码：12345678\n购买方：甲公司\n销售方：乙公司\n价税合计：¥200.00"))
      .toBe("INVOICE");
  });

  it("does not reclassify an ordinary payment screenshot from a single ambiguous word", () => {
    expect(classifyDocumentType("PAYMENT", "向商户付款成功，收款方：乙公司，金额 200.00"))
      .toBe("PAYMENT");
  });

  it("preserves an explicit invoice-field classification even when OCR text is empty", () => {
    expect(classifyDocumentType("INVOICE", "")).toBe("INVOICE");
  });

  it("classifies chat screenshots without a transaction number as supporting material", () => {
    expect(classifyDocumentType("PAYMENT", "7月1日 上午10:31\n¥600.00\n已收款", { amount: "600.00" }))
      .toBe("SUPPORTING");
  });

  it("accepts payment details with amount, transaction time and transaction number", () => {
    expect(classifyDocumentType("PAYMENT", "金额 600.00\n转账时间 2026年7月1日 10:36:04\n转账单号 1000050001202607010729136897955", { amount: "600.00" }))
      .toBe("PAYMENT");
  });

  it("accepts a bank transfer statement without an order number", () => {
    expect(classifyDocumentType("PAYMENT", [
      "收支详情", "交易卡号 6222****8521", "交易账户 1001****1432",
      "交易时间 2026-07-13 20:29:01", "交易金额 640.00", "对方账户 6171****6666",
    ].join("\n"), { amount: "640.00", paidAt: "2026-07-13T20:29:01" })).toBe("PAYMENT");
  });
});
