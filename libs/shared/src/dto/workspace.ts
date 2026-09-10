import type { Role } from "../roles.js";

/** A row in `GET /workspaces`. */
export type WorkspaceSummary = {
  id: string;
  name: string;
  role: Role;
  currency: string;
  kind: "personal" | "business";
  taxCountry: "CA" | "US" | null;
};

/** A row in `GET /workspaces/:id/members`. */
export type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  /** ISO 8601 timestamp. */
  joinedAt: string;
};

/** Roles a workspace owner can assign to a new member via invite. */
export type InvitedRole = Extract<Role, "editor" | "viewer">;

/** A row in `GET /workspaces/:id/invites`. */
export type Invite = {
  id: string;
  invitedEmail: string;
  invitedRole: InvitedRole;
  /** ISO 8601 timestamps. */
  expiresAt: string;
  createdAt: string;
};

/** Anonymous-readable preview returned by `GET /invites/by-token/:token`. */
export type InvitePreview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  workspaceName: string;
  inviterEmail: string;
  invitedEmail: string;
  invitedRole: InvitedRole;
  /** `null` when fetched without a session; boolean when authenticated. */
  emailMatch: boolean | null;
};
