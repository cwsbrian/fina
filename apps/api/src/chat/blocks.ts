export type TextBlock = { type: "text"; markdown: string };

export type ConfirmCardBlock = {
  type: "confirm_card";
  question: string;
  acceptLabel: string;
  rejectLabel: string;
  acceptIntent: string;
  expiresAt: string;
};

// Named PresentationBlock (not Block) to avoid collision with turn.ts's
// local `Block = TextBlock | ToolBlock` history-row union.
export type PresentationBlock = TextBlock | ConfirmCardBlock;
