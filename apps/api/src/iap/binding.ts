import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { IAP_NAMESPACE } from "@fina/shared";

export function deriveAppleToken(userId: string): string {
  return uuidv5(userId, IAP_NAMESPACE);
}

export function deriveGoogleToken(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

/** SHA-256 hex of an arbitrary binding token, used for storing
 *  tombstones in IapDeletedBinding without recovering the original. */
export function hashBindingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export { writeAccountDeletionTombstones } from "./account-deletion.js";
