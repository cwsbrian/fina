import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const mobileRoot = join(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

function pngSize(rel: string): { width: number; height: number } {
  const file = readFileSync(join(mobileRoot, rel));
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}

function pngColorType(rel: string): number {
  return readFileSync(join(mobileRoot, rel)).readUInt8(25);
}

function pngCornerAlpha(rel: string): number[] {
  const file = readFileSync(join(mobileRoot, rel));
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  // This helper only covers the RGBA PNGs produced for mobile brand assets.
  // It avoids pulling image libs into tests while still checking transparency.
  let offset = 8;
  const chunks: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(file.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const rowBytes = width * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const srcRow = y * (rowBytes + 1);
    const dstRow = y * rowBytes;
    const filter = raw[srcRow];
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[srcRow + 1 + x] ?? 0;
      const left = x >= 4 ? (pixels[dstRow + x - 4] ?? 0) : 0;
      const up = y > 0 ? (pixels[dstRow + x - rowBytes] ?? 0) : 0;
      const upLeft = y > 0 && x >= 4 ? (pixels[dstRow + x - rowBytes - 4] ?? 0) : 0;
      let unfiltered = value;
      if (filter === 1) unfiltered = value + left;
      else if (filter === 2) unfiltered = value + up;
      else if (filter === 3) unfiltered = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        unfiltered = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[dstRow + x] = unfiltered & 0xff;
    }
  }
  const sample = (x: number, y: number) => pixels[y * rowBytes + x * 4 + 3] ?? 0;
  return [
    sample(0, 0),
    sample(width - 1, 0),
    sample(0, height - 1),
    sample(width - 1, height - 1),
  ];
}

describe("mobile brand assets", () => {
  it("uses the transparent icon and text title on the sign-in screen", () => {
    const source = read("app/(auth)/sign-in.tsx");

    expect(source).toContain("../../assets/fina-login-icon.png");
    expect(source).not.toContain("../../assets/fina-login-lockup.png");
    expect(source).not.toContain("../../assets/fina-app-icon.png");
    expect(source).not.toContain("../../assets/fina-icon.png");
    expect(source).not.toContain("../../assets/fina-wordmark.png");
    expect(source).not.toContain("../../assets/logo-dark.png");
    expect(source).toContain("Welcome to Fina");
    expect(source).toContain("width: 76");
    expect(source).toContain("height: 76");
    expect(source).toMatch(
      /<View style=\{styles\.brand\}>\s*<Image[\s\S]*?\/>\s*<\/View>\s*<View style=\{styles\.head\}>\s*<Text style=\{styles\.title\}>Welcome to Fina<\/Text>/,
    );
    expect(source).toMatch(/title:\s*\{[^}]*textAlign:\s*"center"/s);
  });

  it("centers sign-in auth copy and footer actions", () => {
    const source = read("app/(auth)/sign-in.tsx");

    expect(source).toContain('brand: { alignItems: "center"');
    expect(source).toMatch(/sub:\s*\{[^}]*textAlign:\s*"center"/s);
    expect(source).toMatch(/footText:\s*\{[^}]*textAlign:\s*"center"/s);
  });

  it("centers sign-up footer copy", () => {
    const source = read("app/(auth)/sign-up.tsx");

    expect(source).toMatch(/legal:\s*\{[^}]*textAlign:\s*"center"/s);
    expect(source).toMatch(/footText:\s*\{[^}]*textAlign:\s*"center"/s);
  });

  it("renders the shared Wordmark component from image assets", () => {
    const source = read("src/design/Wordmark.tsx");

    expect(source).toContain("fina-wordmark.png");
    expect(source).toContain("fina-wordmark-light.png");
    expect(source).not.toContain("<Text");
  });

  it("points Expo build assets at the new icon and splash files", () => {
    const appJson = JSON.parse(read("app.json"));
    const expo = appJson.expo;

    expect(expo.icon).toBe("./assets/fina-app-icon.png");
    expect(expo.splash.image).toBe("./assets/fina-login-icon.png");
    expect(expo.android.adaptiveIcon.foregroundImage).toBe("./assets/fina-adaptive-icon.png");
    expect(expo.web.favicon).toBe("./assets/fina-favicon.png");
    expect(expo.plugins[2][1].icon).toBe("./assets/fina-notification-icon.png");
  });

  it("ships generated assets with app-store safe dimensions", () => {
    const expected = {
      "assets/fina-wordmark.png": { width: 1202, height: 302 },
      "assets/fina-wordmark-light.png": { width: 1202, height: 302 },
      "assets/fina-app-icon.png": { width: 1024, height: 1024 },
      "assets/fina-adaptive-icon.png": { width: 1024, height: 1024 },
      "assets/fina-login-icon.png": { width: 512, height: 512 },
      "assets/fina-splash.png": { width: 1024, height: 1024 },
      "assets/fina-favicon.png": { width: 512, height: 512 },
      "assets/fina-notification-icon.png": { width: 96, height: 96 },
    };

    for (const [rel, size] of Object.entries(expected)) {
      expect(existsSync(join(mobileRoot, rel)), rel).toBe(true);
      expect(pngSize(rel), rel).toEqual(size);
    }

    expect(pngColorType("assets/fina-login-icon.png")).toBe(6);
  });

  it("uses transparent Android native splash logos", () => {
    const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

    for (const density of densities) {
      const rel = `android/app/src/main/res/drawable-${density}/splashscreen_logo.png`;
      if (!existsSync(join(mobileRoot, rel))) continue;
      expect(pngColorType(rel), rel).toBe(6);
      expect(pngCornerAlpha(rel), rel).toEqual([0, 0, 0, 0]);
    }

    const colorsXmlPath = "android/app/src/main/res/values/colors.xml";
    if (existsSync(join(mobileRoot, colorsXmlPath))) {
      const colorsXml = read(colorsXmlPath);
      expect(colorsXml).toContain('<color name="splashscreen_background">#071F1D</color>');
    }
  });

  it("does not leave opaque cached Android splash logos when local build outputs exist", () => {
    const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

    for (const density of densities) {
      const rel = `android/app/build/intermediates/packaged_res/debug/packageDebugResources/drawable-${density}-v4/splashscreen_logo.png`;
      if (!existsSync(join(mobileRoot, rel))) continue;
      expect(pngColorType(rel), rel).toBe(6);
      expect(pngCornerAlpha(rel), rel).toEqual([0, 0, 0, 0]);
    }
  });
});
