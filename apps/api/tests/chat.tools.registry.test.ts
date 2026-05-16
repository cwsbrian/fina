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
        "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing.",
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
