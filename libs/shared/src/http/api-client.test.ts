import { afterEach, describe, expect, it, vi } from "vitest";

import { makeApiFetch } from "./api-client.js";
import { isApiError } from "../errors.js";

describe("makeApiFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a canonical network_unreachable error when fetch cannot reach the backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );

    const apiFetch = makeApiFetch({
      baseUrl: "http://localhost:4000",
      getActiveWorkspaceId: () => null,
    });

    await expect(apiFetch("/me")).rejects.toMatchObject({
      status: 0,
      code: "network_unreachable",
      message: "Backend is unreachable",
    });
  });

  it("still exposes API JSON errors as canonical ApiError values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const apiFetch = makeApiFetch({
      baseUrl: "http://localhost:4000",
      getActiveWorkspaceId: () => null,
    });

    await expect(apiFetch("/me")).rejects.toSatisfy((e) => {
      return isApiError(e) && e.status === 401 && e.code === "unauthenticated";
    });
  });
});
