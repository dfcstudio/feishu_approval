import { describe, expect, it } from "vitest";
import { extractPaymentFields } from "../src/services/ocr/MockOCRProvider.js";
import { extractResponseText, normalizeOcrJson, toDataUrl } from "../src/services/ocr/OpenAIVisionOCRProvider.js";
import { sanitizeDatabaseText } from "../src/utils/databaseText.js";

describe("OCR fallback extraction", () => {
  it("preserves native PDF MIME data for GLM-OCR layout parsing", () => {
    expect(toDataUrl(Buffer.from("%PDF-1.7"), "application/pdf"))
      .toBe("data:application/pdf;base64,JVBERi0xLjc=");
  });

  it("removes PostgreSQL-incompatible NUL characters from OCR text", () => {
    expect(sanitizeDatabaseText("价税\u0000合计：17.47")).toBe("价税合计：17.47");
  });

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

  it("uses the actual-paid amount in shopping order screenshots with an invoice-details action", () => {
    const amounts = [
      "¥20.4实付¥19.38（免运费）",
      "¥18.6 ¥实付 ¥17.67（免运费）",
      "¥5.1实付¥2.1（免运费）",
      "¥5.1 ¥实付 ¥0.1（免运费）",
      "¥63实付¥56.85（免运费）",
    ].map((line) => extractPaymentFields(`交易成功\n${line}\n发票详情`).amount);

    expect(amounts).toEqual(["19.38", "17.67", "2.10", "0.10", "56.85"]);
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

  it("uses the tax-inclusive invoice total instead of the pre-tax amount", () => {
    const result = extractPaymentFields([
      "增值税电子普通发票",
      "金额 16.48  税率 6%  税额 0.99",
      "价税合计（大写）壹拾柒元肆角柒分",
      "价税合计（小写）：¥17.47",
    ].join("\n"));

    expect(result.amount).toBe("17.47");
  });

  it("does not use a pre-tax invoice amount when the tax-inclusive total is unreadable", () => {
    const result = extractPaymentFields("增值税发票\n金额：16.48\n税额：0.99\n价税合计：无法识别");

    expect(result.amount).toBeUndefined();
  });

  it("reconstructs the tax-inclusive total from explicit pre-tax amount and tax", () => {
    const result = extractPaymentFields("增值税发票\n不含税金额：16.48\n税额：0.99\n价税合计：模糊");

    expect(result.amount).toBe("17.47");
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
