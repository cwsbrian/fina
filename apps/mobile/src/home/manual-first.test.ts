import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");
const readMobile = (path: string) => readFileSync(join(mobileRoot, path), "utf8");

describe("manual-first transaction entry", () => {
  it("leads bankless Home users to manual entry instead of bank connection", () => {
    const home = readMobile("app/(tabs)/index.tsx");
    expect(home).toContain('title: canUseGoals ? "Tell Fina what you spent" : "Add a transaction"');
    expect(home).toContain("if (hasNoBank && hasTransactions === false)");
    expect(home).not.toContain('title: "Connect a bank"');
  });

  it("uses English transaction-first copy in Chat and keeps bank sync optional", () => {
    const chat = readMobile("src/chat/ThreadView.tsx");
    const activity = readMobile("app/(tabs)/activity.tsx");
    expect(chat).toContain("Tell Fina what you spent");
    expect(chat).toContain("Coffee $5 this morning");
    expect(activity).toContain("Bank sync is optional.");
    expect(activity).toContain('label="Connect a bank (optional)"');
  });
});
