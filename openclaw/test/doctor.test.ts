import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Only the two I/O boundaries are replaced: reading the config file and
// spawning a real MCP server. All of doctor's branching is exercised for real.
vi.mock("../src/config/load.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/mcp/session.js", () => ({ McpSession: vi.fn() }));

import { doctor } from "../src/cli/doctor.js";
import { loadConfig } from "../src/config/load.js";
import { McpSession } from "../src/mcp/session.js";
import { configSchema } from "../src/config/schema.js";

const loadConfigMock = vi.mocked(loadConfig);
const McpSessionMock = vi.mocked(McpSession);

let out: string;
let stdout: ReturnType<typeof vi.spyOn>;
const savedKeys = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

beforeEach(() => {
  out = "";
  stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(McpSession).mockReset();
  for (const [key, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  void stdout;
});

function config(raw: unknown) {
  loadConfigMock.mockReturnValue(configSchema.parse(raw));
}

/** A fake MCP session whose start()/tools() behaviour the test controls. */
function session(opts: {
  tools?: Array<{ name: string; scope: string }>;
  startError?: Error;
}) {
  const close = vi.fn().mockResolvedValue(undefined);
  const start = opts.startError
    ? vi.fn().mockRejectedValue(opts.startError)
    : vi.fn().mockResolvedValue(undefined);
  McpSessionMock.mockImplementation(function fakeSession(this: McpSession) {
    return {
      start,
      tools: () => opts.tools ?? [],
      close,
    } as unknown as McpSession;
  } as unknown as typeof McpSession);
  return { close, start };
}

describe("doctor", () => {
  it("returns 1 and reports the reason when the config cannot be loaded", async () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("No config file found. Tried: ./openclaw.toml");
    });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✗ config:");
    expect(out).toContain("No config file found");
    // It must bail before probing MCP.
    expect(McpSessionMock).not.toHaveBeenCalled();
  });

  it("flags a missing ANTHROPIC_API_KEY for the anthropic provider", async () => {
    config({
      provider: { type: "anthropic" },
      mcp: { remote: { url: "https://mcp.local" } },
    });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✓ config loaded");
    expect(out).toContain("provider: anthropic (claude-opus-4-7)");
    expect(out).toContain("✗ ANTHROPIC_API_KEY not set");
  });

  it("accepts the anthropic provider once the key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    config({
      provider: { type: "anthropic" },
      mcp: { remote: { url: "https://mcp.local" } },
    });
    expect(await doctor()).toBe(0);
    expect(out).toContain("✓ provider credentials present");
    expect(out).not.toContain("ANTHROPIC_API_KEY not set");
  });

  it("flags a missing OPENAI_API_KEY for the openai provider", async () => {
    config({
      provider: { type: "openai" },
      mcp: { remote: { url: "https://mcp.local" } },
    });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✗ OPENAI_API_KEY not set");
  });

  it("does not require a key for local providers", async () => {
    config({
      provider: { type: "ollama" },
      mcp: { remote: { url: "https://mcp.local" } },
    });
    expect(await doctor()).toBe(0);
    expect(out).toContain("✓ provider credentials present");
  });

  it("fails when neither MCP transport is configured", async () => {
    process.env.OPENAI_API_KEY = "sk-oai";
    config({ provider: { type: "openai" } });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✗ no MCP transport configured");
  });

  it("probes the local MCP server and lists in-scope tools", async () => {
    config({
      provider: { type: "mock" },
      mcp: { local: { scopes: ["read", "write"] } },
    });
    const { close } = session({
      tools: [
        { name: "notes.search", scope: "read" },
        { name: "notes.create", scope: "write" },
      ],
    });

    expect(await doctor()).toBe(0);
    expect(out).toContain("✓ local MCP connected, 2 tools allowed in scope");
    expect(out).toContain("- notes.search [read]");
    expect(out).toContain("- notes.create [write]");
    expect(close).toHaveBeenCalledTimes(1);

    // The declared scopes are handed to the session as its allow-list.
    expect(McpSessionMock.mock.calls[0][0]).toMatchObject({
      command: "node",
      args: ["mcp/dist/index.cjs"],
      allowedScopes: ["read", "write"],
    });
  });

  it("returns 1 and reports the failure when the local MCP probe throws", async () => {
    config({ provider: { type: "mock" }, mcp: { local: {} } });
    session({ startError: new Error("spawn ENOENT") });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✗ local MCP failed:");
    expect(out).toContain("spawn ENOENT");
  });

  it("accumulates failures across independent checks", async () => {
    config({ provider: { type: "openai" }, mcp: { local: {} } });
    session({ startError: new Error("nope") });
    expect(await doctor()).toBe(1);
    expect(out).toContain("✗ OPENAI_API_KEY not set");
    expect(out).toContain("✗ local MCP failed:");
  });
});
