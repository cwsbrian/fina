import { describe, expect, it } from "vitest";
import { buildWelcomeEmail } from "../src/email/welcome.js";

describe("buildWelcomeEmail", () => {
  it("welcomes the user and points them to the in-app support screen", () => {
    const email = buildWelcomeEmail({
      email: "jane@example.com",
      name: "Jane Doe",
    });

    expect(email.to).toBe("jane@example.com");
    expect(email.subject).toBe("Welcome to Fina");
    expect(email.text).toContain("Hi Jane,");
    expect(email.text).toContain("More → Contact support");
    expect(email.text).toContain("feedback");
    expect(email.text).toContain("feature you'd love to see");
    expect(email.html).toContain("More → Contact support");
  });

  it("uses a generic greeting without a name and escapes names in HTML", () => {
    expect(buildWelcomeEmail({ email: "user@example.com" }).text.startsWith("Hi,")).toBe(true);

    const email = buildWelcomeEmail({
      email: "user@example.com",
      name: "<Brian>",
    });
    expect(email.text.startsWith("Hi <Brian>,")).toBe(true);
    expect(email.html).toContain("Hi &lt;Brian&gt;,");
    expect(email.html).not.toContain("Hi <Brian>,");
  });
});
