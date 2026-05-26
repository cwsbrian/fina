import { describe, it, expect } from "vitest";
import { X509Certificate, createHash } from "node:crypto";
import { APPLE_ROOT_CERTS, EXPECTED_APPLE_ROOT_SPKI_SHA256 } from "../../src/iap/apple-roots.js";

describe("APPLE_ROOT_CERTS", () => {
  it("contains no placeholder markers", () => {
    for (const pem of APPLE_ROOT_CERTS) {
      const s = pem.toString("utf8");
      expect(s).not.toMatch(/<<INSTALLER/);
      expect(s).not.toMatch(/INSTALLER_FILL/);
      expect(s).not.toMatch(/INSTALLER/);
    }
  });

  it("every cert parses as X.509 and its SPKI SHA-256 is in the expected pin set", () => {
    for (const pem of APPLE_ROOT_CERTS) {
      const cert = new X509Certificate(pem);
      const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const hash = createHash("sha256").update(spki).digest("hex");
      expect(EXPECTED_APPLE_ROOT_SPKI_SHA256).toContain(hash);
    }
  });
});
