import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toGeminiFunctionDeclarations } from "../src/chat/gemini-adapter.js";
import type { ToolDef } from "../src/chat/tools/types.js";

const withArgs: ToolDef = {
  name: "foo",
  description: "Does foo.",
  args: z.object({
    bar: z.string().describe("the bar value"),
    baz: z.number().optional().describe("optional baz"),
  }),
  run: async () => ({}),
};

const zeroArg: ToolDef = {
  name: "ping",
  description: "ping",
  args: z.object({}),
  run: async () => ({}),
};

describe("toGeminiFunctionDeclarations", () => {
  it("emits parametersJsonSchema (not parameters) for non-empty schema", () => {
    const [decl] = toGeminiFunctionDeclarations([withArgs]);
    expect(decl.name).toBe("foo");
    expect(decl.description).toBe("Does foo.");
    expect((decl as { parameters?: unknown }).parameters).toBeUndefined();
    expect(decl.parametersJsonSchema).toBeDefined();
  });

  it("propagates .describe() text into the JSON Schema description", () => {
    const [decl] = toGeminiFunctionDeclarations([withArgs]);
    const schema = decl.parametersJsonSchema as {
      properties: { bar: { description: string }; baz: { description: string } };
    };
    expect(schema.properties.bar.description).toBe("the bar value");
    expect(schema.properties.baz.description).toBe("optional baz");
  });

  it("omits parametersJsonSchema entirely for zero-arg tools", () => {
    const [decl] = toGeminiFunctionDeclarations([zeroArg]);
    expect(decl.parametersJsonSchema).toBeUndefined();
    expect((decl as { parameters?: unknown }).parameters).toBeUndefined();
  });

  it("returns an array in input order", () => {
    const decls = toGeminiFunctionDeclarations([zeroArg, withArgs]);
    expect(decls.map((d) => d.name)).toEqual(["ping", "foo"]);
  });
});
