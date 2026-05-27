import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { sha256 as jsSha256 } from "js-sha256";
import { IAP_NAMESPACE } from "./namespace.js";

const FIXTURE_USER_ID = "fixture-user-id";

describe("IAP binding token parity (server ⇄ mobile)", () => {
  it("uuidv5 from the `uuid` package is deterministic for fixture input", () => {
    const a = uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE)).toBe(a);
  });

  it("js-sha256 (mobile) === node:crypto sha256 (server) for the same UTF-8 input", () => {
    const fromNode = createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex");
    const fromJs = jsSha256(FIXTURE_USER_ID);
    expect(fromJs).toBe(fromNode);
    expect(fromJs).toMatch(/^[0-9a-f]{64}$/);
  });
});
