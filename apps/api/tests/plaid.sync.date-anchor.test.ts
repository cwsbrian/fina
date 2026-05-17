import { describe, it, expect } from "vitest";
import { parsePlaidInstant, plaidOccurredAt, plaidPostedAt } from "../src/plaid/sync.js";

describe("parsePlaidInstant", () => {
  it("anchors a date-only string at UTC noon", () => {
    expect(parsePlaidInstant("2026-05-01").toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("trusts an ISO timestamp with timezone offset", () => {
    expect(parsePlaidInstant("2026-05-01T14:30:00-04:00").toISOString()).toBe("2026-05-01T18:30:00.000Z");
  });

  it("trusts an ISO timestamp with UTC suffix", () => {
    expect(parsePlaidInstant("2026-05-01T00:00:00Z").toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("plaidOccurredAt (uses parsePlaidInstant)", () => {
  const base = { transaction_id: "tx-1", account_id: "a1", amount: 10, pending: false };

  it("prefers authorized_datetime (ISO) when present", () => {
    expect(
      plaidOccurredAt({ ...base, authorized_datetime: "2026-05-01T14:30:00-04:00", date: "2026-05-01" }).toISOString(),
    ).toBe("2026-05-01T18:30:00.000Z");
  });

  it("falls back to authorized_date (date-only) → UTC noon", () => {
    expect(
      plaidOccurredAt({ ...base, authorized_date: "2026-05-01", date: "2026-04-30" }).toISOString(),
    ).toBe("2026-05-01T12:00:00.000Z");
  });

  it("falls through to date (date-only) → UTC noon", () => {
    expect(plaidOccurredAt({ ...base, date: "2026-05-01" }).toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });
});

describe("plaidPostedAt (uses parsePlaidInstant)", () => {
  const base = { transaction_id: "tx-1", account_id: "a1", amount: 10, date: "2026-05-01" };

  it("returns null when pending", () => {
    expect(plaidPostedAt({ ...base, pending: true })).toBeNull();
  });

  it("anchors date-only at UTC noon when posted", () => {
    expect(plaidPostedAt({ ...base, pending: false })!.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("trusts ISO datetime when present", () => {
    expect(
      plaidPostedAt({ ...base, pending: false, datetime: "2026-05-01T20:00:00-04:00" })!.toISOString(),
    ).toBe("2026-05-02T00:00:00.000Z");
  });
});
