import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REGISTRY } from "../src/chat/tools/index.js";
import { toGeminiFunctionDeclarations } from "../src/chat/gemini-adapter.js";

const EXPECTED_NEW_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["listAccounts", "List bank accounts in the workspace with balances, account status, and Plaid connection status."],
  ["getTransactionDetails", "Get full details for one transaction, including account and category context."],
  ["findUncategorizedTransactions", "Find transactions that are uncategorized or have not been manually reviewed."],
  ["getCategoryBreakdown", "Summarize CAD spending by readable category name, including parent category and visual metadata."],
  ["compareSpendingPeriods", "Compare CAD spending between two matching periods by category or merchant and return the largest changes."],
  ["detectRecurringMerchants", "Detect likely recurring merchant payments from recent transaction history using cadence and amount stability heuristics."],
  ["getCashflowSummary", "Summarize CAD income, expenses, and net cashflow for a period, grouped by day or account."],
];

describe("REGISTRY (plan 1e-next)", () => {
  it("contains all seven new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED_NEW_TOOLS) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec for new tools", () => {
    for (const [name, desc] of EXPECTED_NEW_TOOLS) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("every new tool has .describe() on every top-level arg field", () => {
    for (const [name] of EXPECTED_NEW_TOOLS) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool!.args as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const desc = (schema as z.ZodTypeAny).description;
        expect(desc, `${name}.${field} missing description`).toBeTruthy();
      }
    }
  });

  it("Gemini declarations emit parametersJsonSchema for new tools (all have args)", () => {
    const decls = toGeminiFunctionDeclarations(REGISTRY);
    for (const [name] of EXPECTED_NEW_TOOLS) {
      const decl = decls.find((d) => d.name === name);
      expect(decl, `missing declaration for ${name}`).toBeDefined();
      expect(decl!.parametersJsonSchema).toBeDefined();
    }
  });
});

describe("REGISTRY (plan 1e-search)", () => {
  const EXPECTED = [
    [
      "findTransactions",
      "Search transactions with filters: merchant text, date range, amount range, category name, account name. " +
        "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing. " +
        "Date ranges are interpreted in your local timezone.",
    ],
  ] as const;

  it("contains findTransactions", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("has .describe() on every top-level arg field", () => {
    for (const [name] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool!.args as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const desc = (schema as z.ZodTypeAny).description;
        expect(desc, `${name}.${field} missing description`).toBeTruthy();
      }
    }
  });

  it("Gemini declaration emits parametersJsonSchema (has args)", () => {
    const decls = toGeminiFunctionDeclarations(REGISTRY);
    for (const [name] of EXPECTED) {
      const decl = decls.find((d) => d.name === name);
      expect(decl, `missing declaration for ${name}`).toBeDefined();
      expect(decl!.parametersJsonSchema).toBeDefined();
    }
  });
});

describe("REGISTRY (plan 1e-write)", () => {
  const EXPECTED = [
    [
      "createCategory",
      "Create a new active category in the current workspace. Optional parent category by name. " +
        "Throws category_exists if an active category with this name already exists.",
    ],
    [
      "addTransactionNote",
      "Set or clear the note on one transaction. Replaces the existing note entirely (pass null to clear).",
    ],
  ] as const;

  it("contains both new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("has .describe() on every top-level arg field", () => {
    for (const [name] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool!.args as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const desc = (schema as z.ZodTypeAny).description;
        expect(desc, `${name}.${field} missing description`).toBeTruthy();
      }
    }
  });

  it("Gemini declarations emit parametersJsonSchema for both tools", () => {
    const decls = toGeminiFunctionDeclarations(REGISTRY);
    for (const [name] of EXPECTED) {
      const decl = decls.find((d) => d.name === name);
      expect(decl, `missing declaration for ${name}`).toBeDefined();
      expect(decl!.parametersJsonSchema).toBeDefined();
    }
  });
});

describe("REGISTRY (plan 1c-budget)", () => {
  const EXPECTED = [
    [
      "setBudget",
      "Set the monthly budget for a category. Upserts on (workspace, category, month). Use category_id when known, else category_name (case-insensitive). period defaults to this_month.",
    ],
    [
      "getBudget",
      "List monthly budgets. Returns a single-element array when category_id or category_name is provided, else all budgets for the period.",
    ],
    [
      "compareSpendingVsBudget",
      "Compare actual spending against budgets for the given period. Returns per-category amount/spent/remaining/pace status. period defaults to this_month.",
    ],
  ] as const;

  it("contains all three new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("setBudget and getBudget and compareSpendingVsBudget are all registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("setBudget");
    expect(names).toContain("getBudget");
    expect(names).toContain("compareSpendingVsBudget");
  });
});

describe("REGISTRY (plan 1c-merchant-map)", () => {
  const EXPECTED = [
    [
      "mapMerchantToCategory",
      "Bind a merchant to a category. Upserts the mapping and retroactively assigns null-category siblings whose merchantRaw normalizes to the same value. Use category_id when known, else category_name (case-insensitive).",
    ],
  ] as const;

  it("contains the new tool name", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("mapMerchantToCategory is registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("mapMerchantToCategory");
  });
});

describe("REGISTRY (plan 1c-recurring-persist)", () => {
  const EXPECTED = [
    [
      "addRecurring",
      "Add a recurring expense (subscription, bill). Upserts on case-insensitive name within the workspace. Use category_id when known, else category_name (case-insensitive). cadence: monthly | semimonthly | biweekly | weekly | yearly. next_occurrence_date: YYYY-MM-DD.",
    ],
    [
      "listRecurring",
      "List all recurring expenses in the workspace, ordered by next occurrence date. Includes the resolved category name (null if uncategorized).",
    ],
    [
      "removeRecurring",
      "Remove a recurring expense. Hard delete. Provide exactly one of recurring_id (preferred) or name (case-insensitive resolve).",
    ],
  ] as const;

  it("contains all three new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("registry has 36 tools total", () => {
    // Cumulative source-of-truth count. Bump this when a new tool is added
    // to apps/api/src/chat/tools/index.ts REGISTRY. The number is checked
    // ONCE here, not in every plan-specific describe (prior duplicates
    // removed in 1K-cleanup). 30 base tools + 6 goal tools (listGoals,
    // getGoalDetails, presentGoalForm, addGoal, updateGoal, archiveGoal)
    // = 36.
    expect(REGISTRY).toHaveLength(36);
  });

  it("addRecurring, listRecurring, removeRecurring are all registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("addRecurring");
    expect(names).toContain("listRecurring");
    expect(names).toContain("removeRecurring");
  });
});

describe("REGISTRY (plan 1c-confirmation)", () => {
  const EXPECTED = [
    [
      "presentConfirmCard",
      "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring, addScheduledSpend, dismissScheduledSpend, removeScheduledSpend, updateGoal, archiveGoal. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring, archiveGoal) and ambiguous or large changes. The action runs only when the user taps accept.",
    ],
  ] as const;

  it("contains the new tool name", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("presentConfirmCard is registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("presentConfirmCard");
  });
});
