import { describe, expect, it } from "vitest";
import { markdownToPlainPreview } from "../src/push/markdown-preview.js";

describe("markdownToPlainPreview", () => {
  it("strips bold/italic markers", () => {
    expect(markdownToPlainPreview("**Hello** _world_")).toBe("Hello world");
  });

  it("strips heading markers", () => {
    expect(markdownToPlainPreview("# New month\n\n## stats")).toBe("New month  stats");
  });

  it("collapses newlines to spaces", () => {
    expect(markdownToPlainPreview("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("converts [text](url) to text", () => {
    expect(markdownToPlainPreview("see [docs](https://example.com)")).toBe("see docs");
  });

  it("strips backticks and quote markers", () => {
    expect(markdownToPlainPreview("> hint: `code`")).toBe("hint: code");
  });

  it("truncates to max length with ellipsis", () => {
    const long = "a".repeat(200);
    const out = markdownToPlainPreview(long, 50);
    expect(out).toHaveLength(51);  // 50 chars + …
    expect(out.endsWith("…")).toBe(true);
  });

  it("no ellipsis when shorter than max", () => {
    expect(markdownToPlainPreview("short", 50)).toBe("short");
  });

  it("real brief sample — strips MD and keeps readable", () => {
    const brief = "좋은 아침! 어제 **Starbucks** 한 건 분류 필요해.\n오늘 시장 _$100_ 잡혀있어.";
    expect(markdownToPlainPreview(brief, 200)).toBe(
      "좋은 아침! 어제 Starbucks 한 건 분류 필요해. 오늘 시장 $100 잡혀있어."
    );
  });
});
