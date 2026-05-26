import type { ChatMessageRole } from "../enums.js";

/** Plan 2-chat-user-scope: threads are user-owned with nullable workspace.
 *  workspaceId is `null` until the user's first message binds the thread. */
export type ChatThreadDTO = {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  /** ISO 8601 timestamps. */
  lastMessageAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 timestamp the user last marked this thread as read, or null
   *  if the thread has never been opened. */
  lastReadAt: string | null;
  /** Server-computed count of assistant messages in this thread whose
   *  createdAt is after lastReadAt (or all assistant messages if
   *  lastReadAt is null). user/tool role messages are NOT counted. */
  unreadCount: number;
};

/** A row from `GET /chat/threads/:tid` messages list, or the user/assistant
 *  messages returned by `POST /chat/threads/:tid/messages`. */
export type ChatMessageDTO = {
  id: string;
  role: ChatMessageRole;
  /** Discriminated union of presentation blocks — see PresentationBlock. */
  blocks: unknown;
  /** ISO 8601 timestamp. */
  createdAt: string;
};

/** UI block kinds the assistant can emit. Renderers in mobile/web should
 *  exhaustively handle this union. */
export type PresentationBlock =
  | { type: "text"; markdown: string }
  | {
      type: "confirm_card";
      question: string;
      accept_label: string;
      reject_label: string;
      accept_intent: string;
      reject_intent?: string;
    }
  | {
      type: "categorize_confirm_card";
      count: number;
      items: { txId: string; merchant: string; categoryName: string }[];
      moreCount: number;
    };
