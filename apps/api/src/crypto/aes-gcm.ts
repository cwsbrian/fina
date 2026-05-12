import crypto from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let cachedKeyForBase64: string | null = null;

function getKey(env: { ENCRYPTION_KEY: string }): Buffer {
  if (cachedKey && cachedKeyForBase64 === env.ENCRYPTION_KEY) return cachedKey;
  const buf = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `ENCRYPTION_KEY must be base64 of exactly ${KEY_LEN} bytes (got ${buf.length})`,
    );
  }
  cachedKey = buf;
  cachedKeyForBase64 = env.ENCRYPTION_KEY;
  return buf;
}

export function encrypt(
  env: { ENCRYPTION_KEY: string },
  plaintext: string,
  aad: string,
): { ciphertext: Buffer; iv: Buffer } {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(env), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]), iv };
}

export function decrypt(
  env: { ENCRYPTION_KEY: string },
  ciphertext: Buffer,
  iv: Buffer,
  aad: string,
): string {
  if (ciphertext.length < TAG_LEN) {
    throw new Error("ciphertext too short to contain auth tag");
  }
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, getKey(env), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
