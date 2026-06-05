import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "--font-inter" }),
}));

vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: () => null,
}));

vi.mock("../components/Toaster.client", () => ({
  Toaster: () => null,
}));

describe("RootLayout metadata", () => {
  it("uses real favicon assets from the provided Fina icon", async () => {
    const { metadata } = await import("./layout");

    expect(metadata.icons).toEqual({
      icon: "/favicon.ico",
      shortcut: "/favicon.ico",
      apple: "/apple-icon.png",
    });

    const publicDir = join(process.cwd(), "public");
    const brandingIcon = join(process.cwd(), "../../branding/icon.png");

    expect(existsSync(brandingIcon)).toBe(true);
    expect(existsSync(join(publicDir, "favicon.ico"))).toBe(true);
    expect(existsSync(join(publicDir, "icon.png"))).toBe(true);
    expect(existsSync(join(publicDir, "apple-icon.png"))).toBe(true);
  });
});
