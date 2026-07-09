import { BusinessError } from "./errors.js";

export const normalizeMoney = (input: unknown): string => {
  if (input === null || input === undefined || input === "") {
    throw new BusinessError("Money value is empty", "MONEY_EMPTY");
  }

  const text =
    typeof input === "number"
      ? input.toFixed(2)
      : String(input).replace(/[,，\s]/g, "").replace(/[￥¥元]|RMB|CNY/gi, "");

  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    throw new BusinessError(`Cannot parse money value: ${String(input)}`, "MONEY_PARSE_FAILED");
  }

  return centsToDecimal(Math.abs(decimalToCents(match[0])));
};

export const decimalToCents = (value: string): number => {
  const sign = value.trim().startsWith("-") ? -1 : 1;
  const normalized = value.trim().replace(/^[+-]/, "");
  const [yuan = "0", fraction = ""] = normalized.split(".");
  const cents = Number(yuan) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(cents)) {
    throw new BusinessError(`Cannot normalize money value: ${value}`, "MONEY_PARSE_FAILED");
  }
  return sign * cents;
};

export const moneyEquals = (left?: string | null, right?: string | null): boolean => {
  if (!left || !right) return false;
  return decimalToCents(left) === decimalToCents(right);
};

export const centsToDecimal = (cents: number): string => {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
};
