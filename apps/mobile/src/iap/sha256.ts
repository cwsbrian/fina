import { sha256 } from "js-sha256";

/** Synchronous SHA-256 hex. Used by deriveGoogleToken to produce the
 *  Android obfuscatedAccountId. js-sha256 is pure-JS, runs under Hermes.
 *  UTF-8 input encoding matches the server's node:crypto sha256(utf8) —
 *  verified by libs/shared/src/iap/binding-parity.test.ts. */
export function sha256Hex(input: string): string {
  return sha256(input);
}
