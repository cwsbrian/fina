import type { Tier } from "../tier.js";
import type { UserRole } from "../user-role.js";
import type { SubscriptionDTO } from "./subscription.js";

export type AdminUserDTO = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  role: UserRole;
  tier: Tier;
  trial: {
    active: boolean;
    endsAt: string | null;
  };
  subscription: (SubscriptionDTO & {
    environment: string;
  }) | null;
  deviceSummary: {
    platform: string;
    lastSeenAt: string | null;
  }[];
  activeSubscriptionCount: number;
  isPlanMismatch: boolean;
};

export type AdminUsersResponse = {
  users: AdminUserDTO[];
  nextCursor: string | null;
};

export type AdminUserDetailDTO = {
  user: AdminUserDTO;
  devices: {
    platform: string;
    lastSeenAt: string;
    createdAt: string;
  }[];
  sessions: {
    platform: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  }[];
  plaidItems: {
    id: string;
    institutionName: string;
    status: string;
    errorCode: string | null;
    lastSyncAt: string | null;
    createdAt: string;
    accounts: {
      id: string;
      name: string;
      mask: string | null;
      type: string;
      subtype: string | null;
      status: string;
      lastBalanceSyncAt: string | null;
    }[];
  }[];
  activity: {
    lastSeenAt: string | null;
    transactionCount: number;
    lastTransactionAt: string | null;
    chatThreadCount: number;
    chatMessageCount: number;
    lastChatAt: string | null;
  };
  aiUsage: {
    total: {
      callCount: number;
      inputTokens: number;
      outputTokens: number;
      costCad: string;
    };
    monthly: {
      month: string;
      callCount: number;
      inputTokens: number;
      outputTokens: number;
      costCad: string;
    }[];
  };
};
