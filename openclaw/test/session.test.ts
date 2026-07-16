import { describe, expect, it } from "vitest";
import { mcpLocalSchema } from "../src/config/schema.js";
import { scopeFor } from "../src/mcp/session.js";

describe("local MCP defaults", () => {
  it("targets the CommonJS artifact emitted by the MCP build", () => {
    expect(mcpLocalSchema.parse({}).args).toEqual(["mcp/dist/index.cjs"]);
  });
});

describe("MCP tool scopes", () => {
  it.each([
    ["standard_red_notes_status", "read"],
    ["notes.search", "read"],
    ["notes.create", "write"],
    ["tags.list", "read"],
    ["tags.apply", "write"],
    ["vaults.list", "read"],
    ["vaults.create", "write"],
    ["vaults.delete", "admin"],
    ["toString", "admin"],
    ["unrecognized.tool", "admin"],
  ] as const)("classifies %s as %s", (tool, scope) => {
    expect(scopeFor(tool)).toBe(scope);
  });
});
