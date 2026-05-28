export type TextBlock = { type: "text"; markdown: string };

export type ConfirmCardBlock = {
  type: "confirm_card";
  question: string;
  // Snake-case keys mirror the shared PresentationBlock dto exactly —
  // mobile reads block.accept_label etc., so any drift here renders as
  // empty button labels on the device.
  accept_label: string;
  reject_label: string;
  accept_intent: string;
  reject_intent?: string;
};

export type CategorizeConfirmCardBlock = {
  type: "categorize_confirm_card";
  count: number;
  items: { txId: string; merchant: string; categoryName: string }[];
  moreCount: number;
};

// Named PresentationBlock (not Block) to avoid collision with turn.ts's
// local `Block = TextBlock | ToolBlock` history-row union.
export type PresentationBlock = TextBlock | ConfirmCardBlock | CategorizeConfirmCardBlock;
