export const extractInvoiceBuyerName = (rawText?: string | null): string | undefined => {
  if (!rawText) return undefined;
  const match = rawText.match(/购买方(?:信息)?[\s\S]{0,320}?名称\s*[：:]\s*([^<\n]+)/u);
  return match?.[1]?.trim() || undefined;
};

export const invoiceTitleMatches = (
  receivingUnit: string,
  invoiceBuyerName: string,
  aliases: Record<string, string[]>,
): boolean => {
  const expected = normalizeCompanyName(receivingUnit);
  const actual = normalizeCompanyName(invoiceBuyerName);
  if (expected === actual) return true;
  const accepted = Object.entries(aliases).find(([unit]) => normalizeCompanyName(unit) === expected)?.[1] ?? [];
  return accepted.some((alias) => normalizeCompanyName(alias) === actual);
};

const normalizeCompanyName = (value: string): string =>
  value.normalize("NFKC").replace(/[\s·•—–_－-]/gu, "").replace(/[（(].*?[）)]/gu, "").toLowerCase();
