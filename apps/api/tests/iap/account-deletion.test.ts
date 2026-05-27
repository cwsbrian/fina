import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { writeAccountDeletionTombstones } from "../../src/iap/account-deletion.js";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

beforeEach(async () => { await truncateAll(); });

describe("writeAccountDeletionTombstones", () => {
  it("writes tombstones for both apple and google bindings when present", async () => {
    await prisma.user.create({
      data: {
        id: "u1", email: "u1@test",
        iapAppleAccountToken: deriveAppleToken("u1"),
        iapGoogleObfuscatedId: deriveGoogleToken("u1"),
      },
    });
    await writeAccountDeletionTombstones("u1");
    const apple = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_apple", tokenHash: hashBindingToken(deriveAppleToken("u1")) } },
    });
    const google = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_google", tokenHash: hashBindingToken(deriveGoogleToken("u1")) } },
    });
    expect(apple).not.toBeNull();
    expect(google).not.toBeNull();
  });

  it("no-ops when user has never made an IAP purchase", async () => {
    await prisma.user.create({ data: { id: "u2", email: "u2@test" } });
    await writeAccountDeletionTombstones("u2");
    const rows = await prisma.iapDeletedBinding.findMany();
    expect(rows.length).toBe(0);
  });

  it("idempotent — second call doesn't create duplicate rows", async () => {
    await prisma.user.create({
      data: { id: "u3", email: "u3@test", iapAppleAccountToken: deriveAppleToken("u3") },
    });
    await writeAccountDeletionTombstones("u3");
    await writeAccountDeletionTombstones("u3");
    const rows = await prisma.iapDeletedBinding.findMany({ where: { source: "iap_apple" } });
    expect(rows.length).toBe(1);
  });
});
