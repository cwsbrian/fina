import { vi } from "vitest";

// Hand-rolled mock surface — only the SDK methods our code touches.
export function makeStripeMock() {
  const customersCreate = vi.fn();
  const sessionsCreate = vi.fn();
  const sessionsRetrieve = vi.fn();
  const subsRetrieve = vi.fn();
  const subsList = vi.fn();
  const portalCreate = vi.fn();
  return {
    fns: { customersCreate, sessionsCreate, sessionsRetrieve, subsRetrieve, subsList, portalCreate },
    asStripe() {
      return {
        customers: { create: customersCreate },
        checkout: { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } },
        subscriptions: { retrieve: subsRetrieve, list: subsList },
        billingPortal: { sessions: { create: portalCreate } },
        webhooks: undefined,
      } as any;
    },
  };
}

/** vi.mock the stripe client module so every code path that calls
 * stripeClient(env) gets the same hand-rolled object. Test files
 * import this and immediately invoke installStripeMock() at top level.
 *
 * NOTE: vi.mock() is hoisted by vitest's AST transform only when it
 * appears directly in the test file. Calling vi.mock() inside this
 * helper function body does NOT get hoisted. Use the vi.hoisted pattern
 * in test files instead — see billing-checkout.test.ts for the idiom. */
export function installStripeMock(mock: ReturnType<typeof makeStripeMock>): void {
  vi.mock("../src/stripe/client.js", () => ({
    stripeClient: () => mock.asStripe(),
    _clearStripeClientCache: () => {},
  }));
}

/** Factory for use with vi.hoisted + vi.mock in test files.
 * Usage in test file:
 *
 *   const { stripeMockFactory, makeStripeMock } = await vi.hoisted(
 *     async () => await import("./helpers/stripe-mock.js"),
 *   );
 *   const stripe = makeStripeMock();
 *   vi.mock("../src/stripe/client.js", () => stripeMockFactory(stripe));
 */
export function stripeMockFactory(mock: ReturnType<typeof makeStripeMock>) {
  return {
    stripeClient: () => mock.asStripe(),
    _clearStripeClientCache: () => {},
  };
}
