type Brand<T, B> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type MembershipId = Brand<string, "MembershipId">;

export const userId = (s: string): UserId => s as UserId;
export const workspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const membershipId = (s: string): MembershipId => s as MembershipId;
