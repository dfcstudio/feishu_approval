import { describe, expect, it } from "vitest";
import { extractInvoiceBuyerName, invoiceTitleMatches } from "../src/services/approval/invoiceTitle.js";

describe("invoice title audit", () => {
  it("extracts the buyer name rather than the seller name", () => {
    expect(extractInvoiceBuyerName("购买方信息 名称：上海丰泰实业发展有限公司玉环银湖分公司\n销售方信息 名称：某商行"))
      .toBe("上海丰泰实业发展有限公司玉环银湖分公司");
  });

  it("accepts an explicitly configured legal-entity alias", () => {
    expect(invoiceTitleMatches(
      "台州玉环万达-娃娃集合营-玉环银湖分公司",
      "上海丰泰实业发展有限公司玉环银湖分公司",
      { "台州玉环万达-娃娃集合营-玉环银湖分公司": ["上海丰泰实业发展有限公司玉环银湖分公司"] },
    )).toBe(true);
  });

  it("does not accept an unrelated company based on loose similarity", () => {
    expect(invoiceTitleMatches("玉环银湖分公司", "其他实业发展有限公司玉环分公司", {})).toBe(false);
  });
});
