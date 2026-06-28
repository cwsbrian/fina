import { describe, expect, it } from "vitest";

import { analysisCategoryRoute } from "./category-route";

describe("analysisCategoryRoute", () => {
  it("builds the existing category detail route with period params", () => {
    expect(
      analysisCategoryRoute({
        categoryId: "cat_dining",
        categoryName: "Dining",
        year: 2026,
        month: 6,
      }),
    ).toEqual({
      pathname: "/analysis/category/[id]",
      params: {
        id: "cat_dining",
        name: "Dining",
        year: "2026",
        month: "6",
      },
    });
  });
});
