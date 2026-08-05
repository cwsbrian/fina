import type { Tier } from "../tier.js";
import type { UserRole } from "../user-role.js";
import type { SubscriptionDTO } from "./subscription.js";
import type { ChatMessageRole } from "../enums.js";

export type SignupEnvironment = "UNKNOWN" | "TEST" | "PRODUCTION";

export type AdminUserDTO = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  role: UserRole;
  signupEnvironment: SignupEnvironment;
  signupPlatform: string | null;
  signupBuildNumber: string | null;
  appleStoreEnvironment: string | null;
  environmentVerifiedAt: string | null;
  tier: Tier;
  trial: {
    active: boolean;
    endsAt: string | null;
  };
  subscription:
    | (SubscriptionDTO & {
        environment: string;
      })
    | null;
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
  summary: {
    userCount: number;
    proUserCount: number;
    maxUserCount: number;
    activeTrialCount: number;
  };
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

export type AdminTransactionDTO = {
  id: string;
  workspace: {
    id: string;
    name: string;
  };
  account: {
    id: string;
    name: string;
    mask: string | null;
  };
  amount: string;
  currency: string;
  merchantRaw: string;
  occurredAt: string;
  pending: boolean;
  source: "plaid" | "manual" | "csv";
  note: string | null;
  removedAt: string | null;
  budgetImpact: "expense" | "income" | "refund" | "excluded";
  allocations: {
    amount: string;
    categoryName: string | null;
  }[];
};

export type AdminTransactionsResponse = {
  transactions: AdminTransactionDTO[];
  nextCursor: string | null;
};

export type AdminChatThreadDTO = {
  id: string;
  title: string | null;
  workspace: {
    id: string;
    name: string;
  } | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  messageCount: number;
};

export type AdminChatThreadsResponse = {
  threads: AdminChatThreadDTO[];
};

export type AdminChatMessageDTO = {
  id: string;
  role: ChatMessageRole;
  blocks: unknown;
  createdAt: string;
};

export type AdminChatMessagesResponse = {
  threadId: string;
  messages: AdminChatMessageDTO[];
  nextCursor: string | null;
};
