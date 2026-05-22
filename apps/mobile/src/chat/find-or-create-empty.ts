import type { ChatThreadDTO } from "@fina/shared";
import { apiFetch } from "../api/client";

type ThreadRow = ChatThreadDTO & {
  messageCount: number;
  firstMessagePreview: string | null;
};

/** "New chat" buttons should never create a SECOND empty thread when
 *  one already exists — the user just gets ghost rows in their history.
 *  Look for an existing thread with zero messages first; only POST
 *  when none is available. Returns the resolved thread id either way. */
export async function findOrCreateEmptyThread(): Promise<string> {
  const { threads } = await apiFetch<{ threads: ThreadRow[] }>(
    "/chat/threads?limit=50",
  );
  const empty = threads.find((t) => t.messageCount === 0);
  if (empty) return empty.id;
  const { thread } = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return thread.id;
}
