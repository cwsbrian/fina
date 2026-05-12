/**
 * Scriptable Plaid mock for vitest. Tests configure a queue of responses
 * per method; the mock pops them in order. Throwing test errors are pushed
 * the same way (queue an Error instance to make the next call reject).
 *
 * Usage (top of every test file that imports anything that imports plaid):
 *   import { vi } from "vitest";
 *   import { plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";
 *
 *   // vi.mock(path, factory) is hoisted above all imports — referencing the
 *   // factory through a regular `import` triggers a TDZ error. `vi.hoisted`
 *   // runs in that same hoisted scope, so dynamic-importing the helper
 *   // inside it gives the factory a stable binding before vi.mock fires.
 *   const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
 *     async () => await import("./helpers/plaid-mock.js"),
 *   );
 *   vi.mock("plaid", hoistedPlaidMockFactory);
 *
 * Important: `vi.mock` IS hoisted to before all imports — that's a feature.
 * The catch is that the FACTORY argument can't be a regular import binding
 * (TDZ error). Use `vi.hoisted(() => import(...))` to lift the factory load
 * into the same hoisted scope, then pass that. See the Usage block above.
 */
// A queued response is one of:
//   - `{ data }`  → the call resolves with this object
//   - `Error`     → the call rejects with this error
//   - `Promise`   → the call awaits this promise (lets tests model "pending
//                   forever" or "resolves later" — required by the soft-
//                   timeout test which pushes `new Promise(() => {})`)
type AnyResponse = { data: unknown } | Error | Promise<{ data: unknown } | Error>;

export const plaidMock = {
  linkTokenCreate: [] as AnyResponse[],
  itemPublicTokenExchange: [] as AnyResponse[],
  accountsGet: [] as AnyResponse[],
  transactionsSync: [] as AnyResponse[],
  itemRemove: [] as AnyResponse[],
};

export function resetPlaidMock(): void {
  for (const k of Object.keys(plaidMock) as (keyof typeof plaidMock)[]) {
    plaidMock[k].length = 0;
  }
}

function pop(method: keyof typeof plaidMock): AnyResponse {
  const next = plaidMock[method].shift();
  if (!next) {
    throw new Error(
      `Plaid mock has no scripted response for ${method}; the test forgot to push one`,
    );
  }
  return next;
}

async function callOrThrow(method: keyof typeof plaidMock) {
  const next = pop(method);
  // Pending-promise variant: the test wants this call to hang (or resolve
  // later via test-controlled signaling). Await the queued promise and
  // unwrap the same union as the synchronous case.
  if (next && typeof (next as Promise<unknown>).then === "function") {
    const resolved = await (next as Promise<{ data: unknown } | Error>);
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }
  if (next instanceof Error) throw next;
  return next as { data: unknown };
}

/**
 * Factory passed to `vi.mock("plaid", plaidMockFactory)` at the top of test
 * files. Returns a fake `plaid` module whose PlaidApi methods consume from
 * the per-method queues in `plaidMock`. Tests push prescripted responses
 * (or Error instances to reject the next call) before invoking the code
 * under test.
 */
export function plaidMockFactory() {
  return {
    Configuration: class {
      constructor(_: unknown) {}
    },
    PlaidApi: class {
      constructor(_: unknown) {}
      async linkTokenCreate() { return callOrThrow("linkTokenCreate"); }
      async itemPublicTokenExchange() { return callOrThrow("itemPublicTokenExchange"); }
      async accountsGet() { return callOrThrow("accountsGet"); }
      async transactionsSync() { return callOrThrow("transactionsSync"); }
      async itemRemove() { return callOrThrow("itemRemove"); }
    },
    PlaidEnvironments: {
      sandbox: "https://sandbox.plaid.com",
      production: "https://production.plaid.com",
    },
  };
}

/** Build a realistic `error` shape that sanitizePlaidError can read. */
export function plaidApiError(opts: {
  error_code: string;
  error_type?: string;
  error_message?: string;
  http_status?: number;
}): Error {
  const e: Error & { response?: unknown } = new Error(opts.error_message ?? opts.error_code);
  e.response = {
    status: opts.http_status ?? 400,
    data: {
      error_code: opts.error_code,
      error_type: opts.error_type ?? "ITEM_ERROR",
      error_message: opts.error_message ?? "",
      request_id: "test_req",
    },
  };
  return e;
}
