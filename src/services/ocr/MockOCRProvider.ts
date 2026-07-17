import { centsToDecimal, decimalToCents, normalizeMoney } from "../../utils/money.js";
import type { OCRProvider, PaymentOCRResult } from "./OCRProvider.js";

export class MockOCRProvider implements OCRProvider {
  async recognizePaymentEvidence(input: {
    fileBuffer: Buffer;
    fileName: string;
    mimeType?: string;
  }): Promise<PaymentOCRResult> {
    const textFromFileName = decodeURIComponent(input.fileName).replace(/[_-]/g, " ");
    const bufferText = input.fileBuffer.toString("utf8");
    const rawText = [textFromFileName, looksLikeText(bufferText) ? bufferText : ""].filter(Boolean).join("\n");
    return extractPaymentFields(rawText || textFromFileName);
  }
}

export const extractPaymentFields = (rawText: string): PaymentOCRResult => {
  const amount = extractAmount(rawText);
  return {
    rawText,
    amount,
    transactionId: extractTransactionId(rawText),
    paidAt: extractPaidAt(rawText),
    payee: extractPayee(rawText),
    confidence: amount ? 0.65 : 0.35,
  };
};

const extractAmount = (text: string): string | undefined => {
  const invoiceTotalPatterns = [
    /价税合计(?:\s*[（(]\s*小写\s*[）)])?[\s|:：]*[（(]?\s*(?:人民币)?\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/iu,
    /(?:含税合计|(?<!不)含税金额)[\s|:：]*\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/iu,
    /[（(]\s*小写\s*[）)][\s|:：]*\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/iu,
  ];
  for (const pattern of invoiceTotalPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeMoney(match[1]);
  }

  const preTax = text.match(/不含税金额[\s|:：]*\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/iu)?.[1];
  const tax = text.match(/税额[\s|:：]*\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/iu)?.[1];
  if (preTax && tax) {
    return centsToDecimal(decimalToCents(normalizeMoney(preTax)) + decimalToCents(normalizeMoney(tax)));
  }

  // An invoice subtotal is not reimbursable total. If the document looks like an
  // invoice but its tax-inclusive total is unreadable, report no amount instead
  // of incorrectly falling back to “金额/不含税金额”.
  // A shopping-order screenshot may contain an “发票详情” action without being
  // an invoice. Only suppress generic amount fallback for strong invoice fields.
  if (/(?:增值税.{0,8}发票|发票(?:号码|代码)|税额|税率|购买方|销售方|价税合计)/u.test(text)) return undefined;

  const patterns = [
    /实付\s*[:：]?\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*(?:元)?/i,
    /(?:支付|付款|金额|合计|total|amount)\s*[:：]?\s*(?:RMB|CNY|[￥¥])?\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*(?:元)?/i,
    /(?:RMB|CNY|[￥¥])\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/i,
    /(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*元/,
    /^\s*(-?\d{1,9}(?:[,.]\d{3})*(?:\.\d{1,2}))\s*$/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeMoney(match[1]);
  }
  return undefined;
};

const extractTransactionId = (text: string): string | undefined => {
  const match = text.match(
    /(?:交易单号|交易号|订单号|流水号|商户单号|transaction\s*id|order\s*id)\s*[:：]?\s*([A-Za-z0-9_-]{6,64})/i,
  );
  return match?.[1];
};

const extractPaidAt = (text: string): string | undefined => {
  const match = text.match(
    /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/,
  );
  if (!match?.[1]) return undefined;
  return match[1].replace("年", "-").replace("月", "-").replace("日", "").replace(/\//g, "-");
};

const extractPayee = (text: string): string | undefined => {
  const match = text.match(/(?:商户全称|收款方|商户名称|商户|对方账户|收款账户)\s*[:：]?\s*([^\n\r]{2,60})/);
  return match?.[1]?.trim();
};

const looksLikeText = (value: string): boolean => {
  if (!value.trim()) return false;
  const printable = value.replace(/[^\x20-\x7E\u4E00-\u9FFF\n\r\t]/g, "");
  return printable.length / value.length > 0.7;
};
