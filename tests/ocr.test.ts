import { describe, expect, it } from "vitest";
import { extractPaymentFields } from "../src/services/ocr/MockOCRProvider.js";
import { extractResponseText, normalizeOcrJson } from "../src/services/ocr/OpenAIVisionOCRProvider.js";

describe("OCR fallback extraction", () => {
  it("extracts payment fields from raw text", () => {
    const result = extractPaymentFields([
      "支付金额：¥88.60",
      "交易号：ABC123456789",
      "付款时间：2026-07-01 12:03:04",
      "收款方：测试商户",
    ].join("\n"));

    expect(result.amount).toBe("88.60");
    expect(result.transactionId).toBe("ABC123456789");
    expect(result.paidAt).toBe("2026-07-01 12:03:04");
    expect(result.payee).toBe("测试商户");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("extracts fields from GLM-OCR payment markdown", () => {
    const result = extractPaymentFields([
      "吾悦广场",
      "-35.00",
      "当前状态支付成功",
      "支付时间 2026年6月9日 02:26:35",
      "商户全称 新城吾悦商业管理集团有限公司上海分公司",
      "交易单号 4200003089202606096187571133",
      "商户单号 14BFP202606090226290379933665",
    ].join("\n\n"));

    expect(result.amount).toBe("35.00");
    expect(result.transactionId).toBe("4200003089202606096187571133");
    expect(result.paidAt).toBe("2026-6-9 02:26:35");
    expect(result.payee).toBe("新城吾悦商业管理集团有限公司上海分公司");
  });

  it("normalizes AI OCR JSON output", () => {
    const result = normalizeOcrJson(JSON.stringify({
      rawText: "支付金额：¥1,234.5\n交易号：TXN987654321",
      amount: "¥1,234.5",
      transactionId: "TXN987654321",
      paidAt: null,
      payee: "测试商户",
      confidence: 0.82,
    }));

    expect(result.amount).toBe("1234.50");
    expect(result.transactionId).toBe("TXN987654321");
    expect(result.payee).toBe("测试商户");
    expect(result.confidence).toBe(0.82);
  });

  it("removes labels from the recognized payee", () => {
    const result = normalizeOcrJson(JSON.stringify({
      rawText: "",
      amount: "20.00",
      payee: "商户全称：测试科技有限公司",
      confidence: "0.9",
    }));

    expect(result.payee).toBe("测试科技有限公司");
    expect(result.confidence).toBe(0.9);
  });

  it("extracts text from chat completions style AI responses", () => {
    const text = extractResponseText({
      choices: [
        {
          message: {
            content: "{\"amount\":\"88.60\",\"rawText\":\"支付金额：88.60\",\"confidence\":0.8}",
          },
        },
      ],
    });

    expect(text).toContain("\"amount\":\"88.60\"");
  });
});
