import { describe, expect, it } from "vitest";

import { parseDedupeReconnectArgs } from "../src/scripts/dedupe-reconnect-transactions.js";
import { parseSendWelcomeEmailArgs } from "../src/scripts/send-welcome-email.js";

describe("admin script arguments", () => {
  it("parses a manual welcome-email recipient and optional name", () => {
    expect(
      parseSendWelcomeEmailArgs([
        "--email",
        " Jane@Example.com ",
        "--name",
        "Jane Doe",
      ]),
    ).toEqual({ email: "jane@example.com", name: "Jane Doe" });
  });

  it("rejects an invalid welcome-email recipient", () => {
    expect(() => parseSendWelcomeEmailArgs(["--email", "not-an-email"])).toThrow(
      "Usage:",
    );
  });

  it("keeps reconnect cleanup in dry-run mode by default", () => {
    expect(
      parseDedupeReconnectArgs(["--email", "jane@example.com"]),
    ).toEqual({
      email: "jane@example.com",
      apply: false,
      dateWindowDays: 0,
    });
  });

  it("requires the exact email confirmation before applying cleanup", () => {
    expect(() =>
      parseDedupeReconnectArgs([
        "--email",
        "jane@example.com",
        "--apply",
        "--confirm-email",
        "someone@example.com",
      ]),
    ).toThrow("--apply requires --confirm-email");

    expect(
      parseDedupeReconnectArgs([
        "--email",
        "jane@example.com",
        "--date-window-days",
        "1",
        "--apply",
        "--confirm-email",
        "JANE@example.com",
      ]),
    ).toEqual({
      email: "jane@example.com",
      apply: true,
      dateWindowDays: 1,
    });
  });
});
