import { v5 as uuidv5 } from "uuid";
import { sha256Hex } from "./sha256";
import { IAP_NAMESPACE } from "@fina/shared";

export function deriveAppleToken(userId: string): string {
  return uuidv5(userId, IAP_NAMESPACE);
}

export function deriveGoogleToken(userId: string): string {
  return sha256Hex(userId);
}
