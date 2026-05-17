import { describe, it, expect } from "vitest";
import { parsePlaidInstant } from "../src/plaid/sync.js";

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
