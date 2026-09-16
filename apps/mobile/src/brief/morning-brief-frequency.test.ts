import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("morning brief frequency settings", () => {
  it("explains the global cadence and makes settings available to Free users", () => {
    const source = readMobile("app/brief/index.tsx");

    expect(source).not.toContain("FREQUENCY_OPTIONS");
    expect(source).not.toContain("morningBriefFrequency");
    expect(source).not.toContain("PaidFeatureLock");
    expect(source).toContain("Tap to open Home");
    expect(source).toContain("weekly report on Mondays");
    expect(source).toContain("monthly report on the 1st");
    expect(source).toContain("patch({ pauseEnabled: !v })");
  });
});
