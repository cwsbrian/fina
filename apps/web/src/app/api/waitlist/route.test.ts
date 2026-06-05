import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function request(email: string) {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("POST /api/waitlist", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it("does not report success when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;

    const res = await POST(request("person@example.com"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "email_not_configured",
    });
  });

  it("sends waitlist notifications to the operator inbox", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.WAITLIST_TO = "owner@example.com";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(request("person@example.com"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_test_key",
        }),
        body: expect.stringContaining('"to":"owner@example.com"'),
      }),
    );
  });
});
