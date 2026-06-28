import { describe, expect, it } from "vitest";
import {
  buildSupportEmail,
  supportRecipients,
  validateSupportAttachments,
} from "../src/support/email.js";

const user = {
  userId: "user_123",
  email: "support@example.com",
  name: "Support User",
};

describe("support email", () => {
  it("builds a minimal support email with attachments", () => {
    const email = buildSupportEmail({
      user,
      to: supportRecipients("building.intent@gmail.com, cwsbrian@gmail.com"),
      subject: "Bank sync issue",
      message: "My bank stopped syncing.",
      attachments: [
        {
          filename: "screenshot.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("hello").toString("base64"),
        },
      ],
    });

    expect(email.to).toEqual(["building.intent@gmail.com", "cwsbrian@gmail.com"]);
    expect(email.subject).toBe("[Fina support] Bank sync issue");
    expect(email.text).toContain("support@example.com");
    expect(email.text).toContain("My bank stopped syncing.");
    expect(email.attachments).toEqual([
      {
        filename: "screenshot.txt",
        content: Buffer.from("hello"),
        contentType: "text/plain",
      },
    ]);
  });

  it("rejects invalid attachments", () => {
    expect(() =>
      validateSupportAttachments([
        {
          filename: "bad.txt",
          contentType: "text/plain",
          contentBase64: "not base64",
        },
      ]),
    ).toThrow("invalid_attachment");
  });
});
