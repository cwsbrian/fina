import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { encrypt, decrypt } from "../src/crypto/aes-gcm.js";

const env = { ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };

describe("aes-gcm", () => {
  it("round-trips plaintext with AAD", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    expect(iv.length).toBe(12);
    expect(ciphertext.length).toBeGreaterThan(16); // includes 16-byte auth tag
    const out = decrypt(env, ciphertext, iv, "ws_abc");
    expect(out).toBe("access-secret");
  });

  it("decryption fails when AAD differs", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    expect(() => decrypt(env, ciphertext, iv, "ws_other")).toThrow();
  });

  it("decryption fails when ciphertext is tampered", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0xff, 0);
    expect(() => decrypt(env, ciphertext, iv, "ws_abc")).toThrow();
  });

  it("uses a fresh IV each call (no IV reuse)", () => {
    const a = encrypt(env, "x", "ws");
    const b = encrypt(env, "x", "ws");
    expect(a.iv.equals(b.iv)).toBe(false);
    // Different IV → different ciphertext for same plaintext + key + AAD.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("key length must decode to exactly 32 bytes", () => {
    const tooShort = { ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => encrypt(tooShort, "x", "ws")).toThrow(/32 bytes/);
    const tooLong = { ENCRYPTION_KEY: Buffer.alloc(48).toString("base64") };
    expect(() => encrypt(tooLong, "x", "ws")).toThrow(/32 bytes/);
  });

  it("ciphertext is independent of the helper that wrote it (sanity vs raw decipher)", () => {
    const plaintext = "abc";
    const aad = "ws";
    const { ciphertext, iv } = encrypt(env, plaintext, aad);

    const key = Buffer.from(env.ENCRYPTION_KEY, "base64");
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const enc = ciphertext.subarray(0, ciphertext.length - 16);
    const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
    dec.setAAD(Buffer.from(aad, "utf8"));
    dec.setAuthTag(tag);
    expect(Buffer.concat([dec.update(enc), dec.final()]).toString("utf8")).toBe(plaintext);
  });
});
