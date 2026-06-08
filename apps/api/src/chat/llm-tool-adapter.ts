import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "./tools/types.js";

type FunctionDeclaration = {
  name: string;
  description: string;
  parametersJsonSchema?: unknown;
};

export function toLlmFunctionDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const decl: FunctionDeclaration = { name: t.name, description: t.description };
    if (hasAnyKeys(t.args)) {
      decl.parametersJsonSchema = zodToJsonSchema(t.args, { $refStrategy: "none" });
    }
    return decl;
  });
}

function hasAnyKeys(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  return Object.keys(schema.shape).length > 0;
}
