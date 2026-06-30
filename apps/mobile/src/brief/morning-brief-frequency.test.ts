import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("morning brief frequency settings", () => {
  it("shows compact frequency options and patches morningBriefFrequency", () => {
    const source = readMobile("app/brief/index.tsx");

    expect(source).toContain("Frequency");
    expect(source).toContain("Needs attention");
    expect(source).toContain("Only when Fina spots something important");
    expect(source).toContain("Every morning");
    expect(source).toContain("Send a brief even on quiet days");
    expect(source).toContain("morningBriefFrequency");
    expect(source).toContain('value: "issues_only"');
    expect(source).toContain('value: "daily"');
    expect(source).toContain("patch({ morningBriefFrequency: opt.value })");
  });
});
