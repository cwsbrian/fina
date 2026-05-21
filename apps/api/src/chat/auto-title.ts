import { prisma } from "../db.js";
import { callTitleLLM } from "./auto-title-llm.js";
import type { Env } from "../env.js";

const MAX_LEN = 200; // matches chat_threads.title TEXT(200) cap

// Pure: First non-empty line, strip matched outer quotes, trim, cap to MAX_LEN.
// Returns null if nothing meaningful remains.
export function cleanTitle(raw: string): string | null {
  if (!raw) return null;
  let line = "";
  for (const candidate of raw.split("\n")) {
    if (candidate.trim().length > 0) {
      line = candidate;
      break;
    }
  }
  let s = line.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  if (s.length === 0) return null;
  if (s.length > MAX_LEN) return s.slice(0, MAX_LEN);
  return s;
}

// Fire-and-forget. Caller does `void generateAndPersistThreadTitle(...)`.
// On any failure, logs via console.warn and resolves — never throws.
// The DB update uses `WHERE title IS NULL` so a manual PATCH during the
// async window is preserved. Auth is enforced at the route layer
// (thread.userId === session.userId), so the conditional update needs
// no further scoping.
export async function generateAndPersistThreadTitle(
  env: Env,
  threadId: string,
  firstMessageText: string,
): Promise<void> {
  try {
    const raw = await callTitleLLM(env, firstMessageText);
    const cleaned = cleanTitle(raw);
    if (cleaned === null) return;
    await prisma.chatThread.updateMany({
      where: { id: threadId, title: null },
      data: { title: cleaned, updatedAt: new Date() },
    });
  } catch (err) {
    console.warn("auto-title failed", { threadId, err });
  }
}
