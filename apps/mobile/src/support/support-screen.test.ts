import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readMobile(rel: string) {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

describe("support screen", () => {
  it("is reachable from More and submits attachments through the API", () => {
    const supportPath = join(mobileRoot, "app/support.tsx");
    expect(existsSync(supportPath)).toBe(true);

    const more = readMobile("app/(tabs)/more.tsx");
    const support = readMobile("app/support.tsx");
    const pkg = readMobile("package.json");

    expect(more).toContain('title="Contact support"');
    expect(more).toContain('router.push("/support" as never)');
    expect(support).toContain('apiFetch("/support/tickets"');
    expect(support).toContain('Alert.alert("Attach file"');
    expect(support).toContain("Keyboard.dismiss()");
    expect(support).toContain("requestAnimationFrame");
    expect(support).toContain("ImagePicker.launchImageLibraryAsync");
    expect(support).toContain("DocumentPicker.getDocumentAsync");
    expect(support).toContain("ref={messageRef}");
    expect(support).toContain("new File(a.uri).base64()");
    expect(pkg).toContain('"expo-document-picker"');
    expect(pkg).toContain('"expo-file-system"');
    expect(pkg).toContain('"expo-image-picker"');
  });
});
