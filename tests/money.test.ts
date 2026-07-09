import { describe, expect, it } from "vitest";
import { moneyEquals, normalizeMoney } from "../src/utils/money.js";

describe("money utilities", () => {
  it("normalizes currency text without floating point drift", () => {
    expect(normalizeMoney("￥1,234.50元")).toBe("1234.50");
    expect(normalizeMoney("RMB 88")).toBe("88.00");
    expect(normalizeMoney("-88.00")).toBe("88.00");
  });

  it("compares decimal money values by cents", () => {
    expect(moneyEquals("10.0", "10.00")).toBe(true);
    expect(moneyEquals("10.01", "10.00")).toBe(false);
  });
});
