import type { CategorizationMode } from "@fina/shared";

export type NeedsConfirmationSource = "mapping" | "history" | "ai" | "manual";

export type NeedsConfirmationInput = {
  mode: CategorizationMode;
  source: NeedsConfirmationSource;
  isOther: boolean;
  /** For source='history' only: the prior allocation's needsConfirmation.
   *  null for non-history sources. */
  priorNeedsConfirmation: boolean | null;
};

export function computeNeedsConfirmation(input: NeedsConfirmationInput): boolean {
  if (input.isOther) return true; // mode-override
  if (input.source === "mapping" || input.source === "manual") return false;
  if (input.source === "history" && input.priorNeedsConfirmation === false) return false;
  // remaining: source='ai' OR source='history' with prior unconfirmed
  switch (input.mode) {
    case "strict":   return true;
    case "flexible": return input.source === "ai";
    case "auto":     return false;
  }
}
