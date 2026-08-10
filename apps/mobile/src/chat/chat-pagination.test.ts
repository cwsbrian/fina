import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const threadView = readFileSync(join(__dirname, "ThreadView.tsx"), "utf8");

describe("chat message pagination", () => {
  it("opens at the latest message without an animated content-size scroll", () => {
    expect(threadView).toContain("inverted={invertedMessages.length > 0}");
    expect(threadView).toContain("scrollToOffset({ offset: 0, animated: true })");
    expect(threadView).not.toContain("onContentSizeChange={scrollToBottom}");
    expect(threadView).not.toContain("scrollToEnd({ animated: true })");
  });

  it("requests older pages only after an upward list interaction", () => {
    expect(threadView).toContain("const MESSAGE_PAGE_SIZE = 30;");
    expect(threadView).toContain("onScrollBeginDrag={() => {");
    expect(threadView).toContain("onEndReached={handleOlderEndReached}");
    expect(threadView).toContain("if (!userRequestedOlderRef.current) return;");
    expect(threadView).toContain("&cursor=${encodeURIComponent(cursor)}");
  });
});
