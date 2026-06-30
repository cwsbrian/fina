import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { notificationRouteForData } from "./push-routing";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("push notification routing", () => {
  it("routes daily brief notification taps to the chat thread", () => {
    expect(notificationRouteForData({ type: "daily-brief", threadId: "thread 123" })).toBe(
      "/(tabs)/chat?thread=thread%20123",
    );
  });

  it("ignores pushes that cannot identify a morning brief thread", () => {
    expect(notificationRouteForData({ type: "daily-brief" })).toBeNull();
    expect(notificationRouteForData({ type: "bank-reconnect", threadId: "thread_123" })).toBeNull();
    expect(notificationRouteForData(null)).toBeNull();
  });

  it("handles notification responses from the root layout", () => {
    const layout = readMobile("app/_layout.tsx");

    expect(layout).toContain("addNotificationResponseListener(handleNotificationResponse)");
    expect(layout).toContain("getLastNotificationResponseAsync");
    expect(layout).toContain("notificationRouteForData");
    expect(layout).toContain("router.push(route as never)");
  });
});
