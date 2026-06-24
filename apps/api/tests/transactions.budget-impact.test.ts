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

  it("excludes same-bank transfer-to rows even without a matched destination account", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 400,
      name: "WQ062 TFR-TO 6911127",
      merchant_name: null,
      personal_finance_category: {
        primary: "TRANSFER_OUT",
        detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      },
    })).toBe("excluded");
  });

  it("excludes account-transfer rows with common own-account transfer markers", () => {
    for (const name of [
      "TRANSFER TO SAVINGS",
      "XFER TO CHEQUING",
      "XFR TO BROKERAGE",
      "TRSF TO ACCOUNT",
      "TRNSFR TO ACCOUNT",
      "ONLINE TRANSFER",
      "INTERNAL TRANSFER",
      "ACCOUNT TRANSFER",
      "BOOK TRANSFER",
      "BETWEEN ACCOUNTS",
    ]) {
      expect(classifyPlaidBudgetImpact({
        amount: 100,
        name,
        merchant_name: null,
        personal_finance_category: {
          primary: "TRANSFER_OUT",
          detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
        },
      })).toBe("excluded");
    }
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

  it("excludes transfer rows with registered or investment account signals", () => {
    for (const name of [
      "TRANSFER TO TFSA",
      "ROTH IRA CONTRIBUTION",
      "PAYROLL 401K TRANSFER",
      "VANGUARD BROKERAGE",
    ]) {
      expect(classifyPlaidBudgetImpact({
        amount: 250,
        name,
        merchant_name: null,
        personal_finance_category: {
          primary: "TRANSFER_OUT",
          detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
        },
      })).toBe("excluded");
    }
  });

  it("excludes strong registered account signals even when Plaid miscategorizes them", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 150,
      name: "TD MHA PPP RSP",
      merchant_name: null,
      personal_finance_category: {
        primary: "GENERAL_SERVICES",
        detailed: "GENERAL_SERVICES_INSURANCE",
      },
    })).toBe("excluded");
  });

  it("does not exclude investment-like words on non-transfer purchases", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 40,
      name: "ROTH BOOKSTORE",
      merchant_name: null,
      personal_finance_category: {
        primary: "GENERAL_MERCHANDISE",
        detailed: "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS",
      },
    })).toBe("expense");
  });

  it("does not match investment keywords inside longer words", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 40,
      name: "MIRACLE SHOP PAYMENT",
      merchant_name: null,
      personal_finance_category: {
        primary: "TRANSFER_OUT",
        detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      },
    })).toBe("expense");
  });

  it("does not exclude person-to-person transfer markers", () => {
    for (const name of [
      "INTERAC E-TRANSFER",
      "SEND E-TFR ***K5P",
      "ZELLE PAYMENT",
      "VENMO CASHOUT",
      "CASH APP TRANSFER",
      "PAYPAL TRANSFER",
    ]) {
      expect(classifyPlaidBudgetImpact({
        amount: 75,
        name,
        merchant_name: null,
        personal_finance_category: {
          primary: "TRANSFER_OUT",
          detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
        },
      })).toBe("expense");
    }
  });
});
