import { vi } from "vitest";

/** Shape mirrors AppleClient / GoogleClient / OAuth2Client surfaces
 *  used by route + sync code. The factory returns ready-to-mutate
 *  vi.fn() spies; each test does `mocks.appleClient.verifyAndDecodeTransaction.mockResolvedValue(...)`. */
export type IapMocks = {
  appleClient: {
    verifyAndDecodeTransaction: ReturnType<typeof vi.fn>;
    verifyAndDecodeNotification: ReturnType<typeof vi.fn>;
    getSubscriptionStatus: ReturnType<typeof vi.fn>;
    _decodeAndVerifyJws: ReturnType<typeof vi.fn>;
  };
  googleClient: {
    fetchAndNormalize: ReturnType<typeof vi.fn>;
    acknowledgeIfPending: ReturnType<typeof vi.fn>;
    _acknowledge: ReturnType<typeof vi.fn>;
  };
  oidcClient: {
    verifyIdToken: ReturnType<typeof vi.fn>;
  };
};

export function makeIapMocks(): IapMocks {
  return {
    appleClient: {
      verifyAndDecodeTransaction: vi.fn(),
      verifyAndDecodeNotification: vi.fn(),
      getSubscriptionStatus: vi.fn(),
      _decodeAndVerifyJws: vi.fn(),
    },
    googleClient: {
      fetchAndNormalize: vi.fn(),
      acknowledgeIfPending: vi.fn().mockResolvedValue(true),
      _acknowledge: vi.fn().mockResolvedValue(undefined),
    },
    oidcClient: {
      verifyIdToken: vi.fn(),
    },
  };
}
