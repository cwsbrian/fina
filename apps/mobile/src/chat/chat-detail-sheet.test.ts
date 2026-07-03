import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("chat detail sheet", () => {
  it("keeps text inline and opens UI blocks from a detail bottom sheet", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("BottomSheetScrollView");
    expect(threadView).toContain("activeDetailBlock");
    expect(threadView).toContain("onDetailPress");
    expect(threadView).toContain("View detail");
    expect(threadView).toContain("accessibilityLabel=\"View message detail\"");
    expect(threadView).toContain("PresentationBlock block={activeDetailBlock.block}");
    expect(threadView).toContain("handleDetailPress(b, message)");
  });

  it("keeps bottom sheet actions in the header", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("detailTitleForBlock");
    expect(threadView).toContain("handleDetailCancel");
    expect(threadView).toContain("handleDetailSave");
    expect(threadView).toContain("<Text style={styles.detailHeaderActionText}>Cancel</Text>");
    expect(threadView).toContain("<Text style={styles.detailHeaderSaveText}>Save</Text>");
    expect(threadView).toContain("detailShowSave");
  });

  it("renders detail sheet content without nested card chrome", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");
    const presentationBlock = readMobile("src/chat/PresentationBlock.tsx");
    const primitives = readMobile("src/chat/blocks/_primitives.tsx");

    expect(threadView).toContain("presentation=\"sheet\"");
    expect(threadView).toContain("formActions=\"header\"");
    expect(threadView).toContain("onFormActionsChange");
    expect(threadView).toContain("onFormActionStateChange");
    expect(presentationBlock).toContain("BlockPresentationProvider");
    expect(primitives).toContain("BlockPresentationContext");
    expect(primitives).toContain("presentation === \"sheet\"");
  });

  it("presents the detail sheet through the root bottom sheet modal layer", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("BottomSheetModal");
    expect(threadView).toContain("requestAnimationFrame(() => detailSheetRef.current?.present())");
    expect(threadView).toContain("detailSheetRef.current?.present()");
    expect(threadView).toContain("detailSheetRef.current?.dismiss()");
    expect(threadView).toContain("onDismiss={clearDetailState}");
  });

  it("keeps assistant actions outside the text bubble while matching the bubble width", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("DETAIL_BLOB_MIN_WIDTH");
    expect(threadView).toContain("SUPPORT_ACTION_MIN_WIDTH");
    expect(threadView).toContain("SUPPORT_ACTION_ICON_SIZE");
    expect(threadView).toContain("lastCardBlockIndex");
    expect(threadView).toContain("hasCardBlocks");
    expect(threadView).toContain("captureActionBubbleWidth");
    expect(threadView).toContain("setActionRowWidth");
    expect(threadView).toContain("actionRowWidthStyle");
    expect(threadView).toContain("renderSupportButton");
    expect(threadView).toContain("renderShareButton");
    expect(threadView).toContain("copyTextToClipboard");
    expect(threadView).toContain("accessibilityLabel=\"Copy answer\"");
    expect(threadView).toContain("name=\"copy-outline\"");
    expect(threadView).toContain("assistantCopyText(message)");
    expect(threadView).toContain("Alert.alert(\"Copied\", \"Answer copied to clipboard.\")");
    expect(threadView).toContain("renderSupportButton(\"compact\")");
    expect(threadView).toContain("styles.supportActionInSupportOnlyRow");
    expect(threadView).toContain([
      "supportActionInDetailRow: {",
      "    minWidth: SUPPORT_ACTION_ICON_SIZE,",
      "    minHeight: 36,",
      "    paddingHorizontal: 0,",
    ].join("\n"));
    expect(threadView).toContain("minWidth: SUPPORT_ACTION_ICON_SIZE");
    expect(threadView).toContain("paddingHorizontal: 0");
    expect(threadView).toContain("styles.assistantBubbleWithDetailActions");
    expect(threadView).toContain("showActionsInDetailRow");
    expect(threadView).toContain("styles.detailActionRow");
    expect(threadView).toContain("styles.supportOnlyActionRow");
    expect(threadView).toContain("styles.supportActionInDetailRow");
    expect(threadView).toContain([
      "detailButtonText: {",
      "    ...type$.button,",
      "    fontSize: 14,",
      "    lineHeight: 16,",
    ].join("\n"));
    expect(threadView).toContain("lastCardBlockIndex === -1");
    expect(threadView).not.toContain("styles.detailBubble");
    expect(threadView).not.toContain("assistantTextSupportFooter");
    expect(threadView).not.toContain("supportActionInBubble");
  });

  it("keeps copy and support grouped next to the detail action", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("styles.messageActionGroup");
    expect(threadView).toContain("showActionsInDetailRow ? (");
    expect(threadView).toContain("<View style={styles.messageActionGroup}>");
    expect(threadView).toContain("{renderShareButton()}");
    expect(threadView).toContain("{renderSupportButton()}");
  });

  it("uses category review copy and closes the detail sheet before opening Activity", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");
    const presentationBlock = readMobile("src/chat/PresentationBlock.tsx");

    expect(threadView).toContain('case "categorize_confirm_card":');
    expect(threadView).toContain('return "Review Categories";');
    expect(threadView).toContain('detailLabelForBlock');
    expect(threadView).toContain('return "Review categories";');
    expect(presentationBlock).toContain('onOpenActivity?: () => void;');
    expect(presentationBlock).toContain('onOpenActivity?.();');
    expect(threadView).toContain("handleOpenActivityFromDetail");
    expect(threadView).toContain('router.push("/(tabs)/activity" as never)');
    expect(threadView).toContain("detailSheetRef.current?.dismiss()");
    expect(presentationBlock).toContain("Review 1 categorized transaction");
    expect(presentationBlock).toContain("Review categorized transactions");
    expect(threadView).toContain("CategoryPickerSheet");
    expect(threadView).toContain("handleChangeCategoryFromDetail");
    expect(threadView).toContain("categoryPickedRef.current?.(cat)");
    expect(presentationBlock).toContain("onChangeCategory?:");
    expect(presentationBlock).toContain("onChangeCategory(it.txId");
    expect(presentationBlock).toContain("Change category");
    expect(presentationBlock).not.toContain("오늘 분류한");
    expect(presentationBlock).not.toContain("외 {block.moreCount}건");
    expect(presentationBlock).toContain("+ {block.moreCount} more");
  });

  it("routes redundant detail blocks directly instead of opening the sheet", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain("detailRouteForBlock");
    expect(threadView).toContain('case "category_list":');
    expect(threadView).toContain('return "/categories";');
    expect(threadView).toContain('case "accounts_list":');
    expect(threadView).toContain('return "/banks";');
    expect(threadView).toContain('case "recurring_list":');
    expect(threadView).toContain('return "/subscriptions";');
    expect(threadView).toContain('case "goals_list":');
    expect(threadView).toContain('return "/goals";');
    expect(threadView).toContain('return `/goal/${block.id}`;');
    expect(threadView).toContain('return `/transactions/${block.id}`;');
  });
});
