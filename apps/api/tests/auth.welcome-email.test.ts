import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";
import { testEnv } from "./helpers/test-env.js";

const { bootstrapMock, sendEmailMock } = vi.hoisted(() => ({
  bootstrapMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("../src/workspaces/bootstrap.js", () => ({
  startTrialAndBootstrapWorkspace: bootstrapMock,
}));

vi.mock("../src/email/send.js", () => ({
  sendEmail: sendEmailMock,
}));

const user = {
  id: "user-1",
  email: "jane@example.com",
  name: "Jane Doe",
  emailVerified: false,
  image: null,
  createdAt: new Date("2026-07-31T00:00:00Z"),
  updatedAt: new Date("2026-07-31T00:00:00Z"),
};

beforeEach(() => {
  bootstrapMock.mockReset();
  sendEmailMock.mockReset();
  bootstrapMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue(undefined);
});

describe("welcome email auth lifecycle", () => {
  it("sends after an email-and-password user verifies their address", async () => {
    const auth = createAuth(testEnv({ RESEND_API_KEY: "re_test" }));
    const afterVerification = auth.options.emailVerification?.afterEmailVerification;

    await afterVerification?.({ ...user, emailVerified: true }, new Request("http://localhost"));

    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledWith(
      "re_test",
      "test@fina.app",
      expect.objectContaining({
        to: "jane@example.com",
        subject: "Welcome to Fina",
      }),
    );
  });

  it("sends on creation for a social user who is already verified", async () => {
    const auth = createAuth(testEnv());
    const afterCreate = auth.options.databaseHooks?.user?.create?.after;

    await afterCreate?.({ ...user, emailVerified: true }, null);

    expect(bootstrapMock).toHaveBeenCalledWith({ userId: "user-1" });
    expect(sendEmailMock).toHaveBeenCalledOnce();
  });

  it("does not send before an email-and-password user verifies", async () => {
    const auth = createAuth(testEnv());
    const afterCreate = auth.options.databaseHooks?.user?.create?.after;

    await afterCreate?.(user, null);

    expect(bootstrapMock).toHaveBeenCalledWith({ userId: "user-1" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not fail verification when the welcome email provider is down", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const auth = createAuth(testEnv());
    const afterVerification = auth.options.emailVerification?.afterEmailVerification;

    await expect(
      afterVerification?.({ ...user, emailVerified: true }, new Request("http://localhost")),
    ).resolves.toBeUndefined();
  });
});
