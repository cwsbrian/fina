import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT_PER_TYPE,
  USER_INSTRUCTION,
  EMPTY_BRIEF_FALLBACK,
} from "../src/chat/brief.js";

// Conjoining jamo (U+1100–11FF) + compatibility jamo (U+3130–318F) +
// full syllable block (U+AC00–D7A3, through 힣). The old ㄱ-힝 range stopped
// 6 codepoints short.
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

describe("brief LLM strings are English (no Hangul)", () => {
  it("system prompts contain no Hangul", () => {
    for (const v of Object.values(SYSTEM_PROMPT_PER_TYPE)) {
      expect(HANGUL.test(v)).toBe(false);
    }
  });
  it("user instruction + fallback contain no Hangul", () => {
    expect(HANGUL.test(USER_INSTRUCTION)).toBe(false);
    expect(HANGUL.test(EMPTY_BRIEF_FALLBACK)).toBe(false);
  });

  // Contract anchors: every per-type prompt carries the RULES block, so each
  // must mention the forecast-first contract. A deleted RULES paragraph fails
  // here (the only deterministic guard on the prompt contract below the LLM).
  it("system prompts state the forecast-first contract anchors", () => {
    for (const v of Object.values(SYSTEM_PROMPT_PER_TYPE)) {
      expect(v).toContain("forecast.portfolio");
      expect(v).toContain("forecast.topRisks");
      expect(v).toContain("hasHistory");
      expect(v).toContain("at_risk");
      expect(v).toContain("highest-risk workspace");
      expect(v).toContain("ask me for a plan to stay on track");
    }
  });
});
