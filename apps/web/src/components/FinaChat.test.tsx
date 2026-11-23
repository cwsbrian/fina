// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageDTO, ChatThreadDTO } from "@fina/shared";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../lib/api", () => ({ apiFetch: fetchMock }));

import { FinaChat } from "./FinaChat";

const thread = { id: "thread-1", workspaceId: "workspace-1" } as ChatThreadDTO;

function response(text: string) {
  return {
    thread,
    messages: [{ id: text, role: "assistant", blocks: [{ type: "text", markdown: text }] }] as ChatMessageDTO[],
    nextCursor: null,
    resolvedIntentIds: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchMock.mockReset();
});

async function show(open: boolean) {
  await act(async () => {
    root.render(<FinaChat open={open} workspaceId="workspace-1" onClose={() => {}} />);
  });
}

describe("FinaChat conversation refresh", () => {
  it("shows messages added while the popover was closed", async () => {
    let latest = response("First message");
    let reads = 0;
    fetchMock.mockImplementation((path: string) => {
      if (path === "/chat/threads") return Promise.resolve({ thread });
      if (path.startsWith("/chat/threads/thread-1?")) {
        reads += 1;
        return Promise.resolve(latest);
      }
      return Promise.resolve({});
    });

    await show(true);
    expect(container.textContent).toContain("First message");

    await show(false);
    latest = response("New brief while closed");
    await show(true);

    expect(reads).toBe(2);
    expect(container.textContent).toContain("New brief while closed");
    expect(container.textContent).not.toContain("First message");
  });

  it("ignores an older response that arrives after reopening", async () => {
    let finishOldRead!: (value: ReturnType<typeof response>) => void;
    const oldRead = new Promise<ReturnType<typeof response>>((resolve) => {
      finishOldRead = resolve;
    });
    let reads = 0;
    fetchMock.mockImplementation((path: string) => {
      if (path === "/chat/threads") return Promise.resolve({ thread });
      if (path.startsWith("/chat/threads/thread-1?")) {
        reads += 1;
        return reads === 1 ? oldRead : Promise.resolve(response("Newest message"));
      }
      return Promise.resolve({});
    });

    await show(true);
    expect(reads).toBe(1);

    await show(false);
    await show(true);
    expect(container.textContent).toContain("Newest message");

    await act(async () => finishOldRead(response("Old message")));
    expect(container.textContent).toContain("Newest message");
    expect(container.textContent).not.toContain("Old message");
  });
});
