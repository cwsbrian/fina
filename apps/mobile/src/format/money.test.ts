import { describe, expect, it } from "vitest";

import { currencySymbol, formatMoney } from "./money";

describe("money display symbols", () => {
  it("uses compact symbols for supported workspace currencies", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("CAD")).toBe("$");
    expect(currencySymbol("JPY")).toBe("¥");
    expect(currencySymbol("EUR")).toBe("€");
  });

  it("never expands USD or JPY amounts to regional labels", () => {
    expect(formatMoney("1234.5", "USD").display).toBe("$1,234.50");
    expect(formatMoney("1234.5", "JPY").display).toBe("¥1,234.50");
  });
});
