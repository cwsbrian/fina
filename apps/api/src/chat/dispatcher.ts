import type { ToolContext, ToolDef } from "./tools/types.js";
import { logError } from "../logger.js";

export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: unknown,
  registry: ToolDef[],
): Promise<DispatchResult> {
  const tool = registry.find((t) => t.name === toolName);
  if (!tool) return { ok: false, error: `unknown_tool: ${toolName}` };

  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `invalid_args: ${parsed.error.message}` };

  try {
    const result = await tool.run(ctx, parsed.data);
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError({ tool: toolName, err: e }, "chat tool failed");
    return { ok: false, error: msg.slice(0, 500) };
  }
}
