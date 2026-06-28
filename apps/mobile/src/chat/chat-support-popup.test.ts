import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("chat support popup", () => {
  it("lets users report an assistant answer without leaving chat", () => {
    const threadView = readMobile("src/chat/ThreadView.tsx");

    expect(threadView).toContain('Modal');
    expect(threadView).toContain('apiFetch("/support/tickets"');
    expect(threadView).toContain('subject: CHAT_SUPPORT_SUBJECT');
    expect(threadView).toContain('const CHAT_SUPPORT_SUBJECT = "Chat issue";');
    expect(threadView).toContain('supportMessage?.role === "assistant"');
    expect(threadView).toContain('Fina answer:');
    expect(threadView).toContain('Thread ID:');
    expect(threadView).toContain('Message ID:');
    expect(threadView).toContain('accessibilityLabel="Report this answer"');
    expect(threadView).toContain("justifyContent: \"flex-end\"");
    expect(threadView).not.toContain('style={styles.supportActionText}>Support</Text>');
  });
});
