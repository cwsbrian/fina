import type { z } from "zod";
import type { Env } from "../../env.js";
import type { Role } from "@fina/shared";

export type ToolContext = {
  env: Env;
  workspaceId: string;
  userId: string;
  role: Role;
};

export type ToolDef<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
