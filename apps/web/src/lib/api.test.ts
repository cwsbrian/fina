import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

process.env.NEXT_PUBLIC_API_URL = "http://localhost:0";

afterEach(() => {
  fetchMock.mockReset();
  vi.clearAllMocks();
});

describe("apiFetch rate_limit_exceeded handler", () => {
  it("fires a localized sonner toast with the parsed retry seconds", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "rate_limit_exceeded",
          message: "Rate limit exceeded. Retry in 28s.",
          statusCode: 429,
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toMatchObject({
      code: "rate_limit_exceeded",
    });
    expect(toast.error).toHaveBeenCalledWith("잠시 후 다시 시도해 주세요 (28초 후)");
  });

  it("omits the seconds when the message doesn't include a Retry in N pattern", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "rate_limit_exceeded",
          message: "no retry hint here",
          statusCode: 429,
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("잠시 후 다시 시도해 주세요");
  });

  it("does NOT fire toast for non-rate-limit errors", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "not_found", statusCode: 404 }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
