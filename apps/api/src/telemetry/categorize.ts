import { logInfo } from "../logger.js";

export function emitCategorizeCompleted(args: {
  workspaceId: string;
  source: "mapping" | "history" | "ai";
  categoryName: string;
  pfcPrimary: string | null;
  pfcConfidence: string | null;
  pfcMissing: boolean;
}) {
  logInfo({ event: "categorize.completed", ...args }, "categorize.completed");
}

export function emitCategorizeConfirmed(args: {
  workspaceId: string;
  source: "mapping" | "history" | "ai" | "manual";
  action: "confirm" | "edit" | "snooze" | "dismiss-auto";
}) {
  logInfo({ event: "categorize.confirmed", ...args }, "categorize.confirmed");
}
