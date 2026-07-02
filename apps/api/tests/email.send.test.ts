import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("resend", () => ({
  Resend: vi.fn(() => ({
    emails: { send: sendMock },
  })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("sendEmail", () => {
  it("throws in production when Resend rejects an unverified sender domain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    sendMock.mockResolvedValueOnce({
      error: { message: "Domain is not verified. Please verify your domain." },
    });
    const { sendEmail } = await import("../src/email/send.js");

    await expect(
      sendEmail("re_valid_test_key_123456789", "Fina <no-reply@buildingintent.com>", {
        to: "building.intent@gmail.com",
        subject: "Support",
        text: "hello",
      }),
    ).rejects.toThrow("Resend send failed");
  });
});
