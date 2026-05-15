import type { z } from "zod";
import type { Env } from "../../env.js";

export type ToolContext = {
  env: Env;
  workspaceId: string;
  userId: string;
};

export type ToolDef<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
