import { describe, expect, it } from "vitest";

import {
  budgetImpactForAmount,
  classifyPlaidBudgetImpact,
} from "../src/transactions/budget-impact.js";

describe("budget impact", () => {
  it("excludes non-expense amounts", () => {
    expect(budgetImpactForAmount(-100)).toBe("excluded");
    expect(budgetImpactForAmount(0)).toBe("excluded");
    expect(budgetImpactForAmount(100)).toBe("expense");
  });

  it("excludes clear credit card payments", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 2448.17,
      name: "AMEX BILL PYMT MSP",
      merchant_name: null,
      personal_finance_category: {
        primary: "LOAN_PAYMENTS",
        detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      },
    })).toBe("excluded");
  });

  it("keeps outgoing e-transfers as expenses", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 270,
      name: "SEND E-TFR ***K5P",
      merchant_name: null,
      personal_finance_category: {
        primary: "TRANSFER_OUT",
        detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      },
    })).toBe("expense");
  });

  it("excludes investment movement", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 250,
      name: "INVESTMENT TRANSFER",
      merchant_name: null,
      personal_finance_category: {
        primary: "TRANSFER_OUT",
        detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
      },
    })).toBe("excluded");
  });
});
