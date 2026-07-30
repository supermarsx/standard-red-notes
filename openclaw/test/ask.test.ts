import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  runResult: {
    finalText: "answer",
    steps: 2,
    stopReason: "end_turn" as "end_turn" | "max_steps" | "error",
  },
  runError: undefined as Error | undefined,
  runCalls: [] as { messages: unknown; opts: Record<string, unknown> }[],
  sessionCtorArgs: [] as Record<string, unknown>[],
  auditFiles: [] as string[],
  auditEntries: [] as unknown[],
  started: 0,
  closed: 0,
}));

vi.mock("../src/config/load.js", () => ({
  loadConfig: () => h.config,
}));

vi.mock("../src/providers/factory.js", () => ({
  resolveProvider: (spec: unknown) => ({ tag: "provider", spec }),
}));

vi.mock("../src/mcp/session.js", () => ({
  sessionOptionsFromConfig: (
    config: {
      mcp: {
        local?: Record<string, unknown>;
        remote?: Record<string, unknown>;
      };
      security: { allow_filesystem_paths: string[] };
    },
    audit: (entry: unknown) => void,
    onStderr: (chunk: string) => void,
  ) => {
    const transport = config.mcp.local
      ? { ...config.mcp.local }
      : { remote: config.mcp.remote };
    return {
      ...transport,
      audit,
      onStderr,
      allowedScopes:
        (config.mcp.local?.scopes as string[] | undefined) ??
        (config.mcp.remote?.scopes as string[] | undefined) ??
        [],
      allowedFilesystemPaths: config.security.allow_filesystem_paths,
    };
  },
  McpSession: class {
    constructor(opts: Record<string, unknown>) {
      h.sessionCtorArgs.push(opts);
    }
    async start() {
      h.started += 1;
    }
    async close() {
      h.closed += 1;
    }
  },
}));

vi.mock("../src/util/audit.js", () => ({
  createAuditSink: (file: string) => {
    h.auditFiles.push(file);
    return (entry: unknown) => h.auditEntries.push(entry);
  },
}));

vi.mock("../src/core/agent.js", () => ({
  run: async (messages: unknown, opts: Record<string, unknown>) => {
    h.runCalls.push({ messages, opts });
    if (h.runError) throw h.runError;
    const onTextDelta = opts.onTextDelta as ((c: string) => void) | undefined;
    onTextDelta?.("chunk-1");
    onTextDelta?.("chunk-2");
    return h.runResult;
  },
}));

const { ask } = await import("../src/cli/ask.js");

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: { type: "mock" },
    agent: {
      audit_file: "~/.openclaw/audit.jsonl",
      max_steps: 7,
      scratchpad_kb: 32,
    },
    security: { allow_filesystem_paths: [] },
    mcp: {
      local: {
        command: "node",
        args: ["mcp/dist/index.cjs"],
        env: { A: "1" },
        scopes: ["read", "write"],
      },
    },
    ...overrides,
  };
}

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.config = baseConfig();
  h.runResult = { finalText: "answer", steps: 2, stopReason: "end_turn" };
  h.runError = undefined;
  h.runCalls.length = 0;
  h.sessionCtorArgs.length = 0;
  h.auditFiles.length = 0;
  h.auditEntries.length = 0;
  h.started = 0;
  h.closed = 0;
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask without an MCP transport", () => {
  it("refuses with exit code 1 and does not start a session or call the agent", async () => {
    h.config = baseConfig({ mcp: {} });

    const code = await ask("what is up");

    expect(code).toBe(1);
    expect(stderr.mock.calls.at(0)?.[0]).toContain("No MCP configured");
    expect(h.started).toBe(0);
    expect(h.runCalls).toHaveLength(0);
  });
});

describe("ask exit codes", () => {
  it.each([
    ["end_turn", 0],
    ["max_steps", 0],
    ["error", 1],
  ] as const)(
    "maps stopReason %s to exit code %i",
    async (reason, expected) => {
      h.runResult = { finalText: "t", steps: 1, stopReason: reason };
      await expect(ask("q")).resolves.toBe(expected);
    },
  );
});

describe("ask session wiring", () => {
  it("starts the session, streams the answer, and closes the session", async () => {
    const code = await ask("what is up");

    expect(code).toBe(0);
    expect(h.started).toBe(1);
    expect(h.closed).toBe(1);
    // The agent's streamed chunks reach stdout, followed by a trailing newline.
    const written = stdout.mock.calls.map((c) => c[0]);
    expect(written).toEqual(["chunk-1", "chunk-2", "\n"]);
  });

  it("passes the question, configured max_steps and granted scopes through", async () => {
    await ask("what is up");

    expect(h.runCalls[0].messages).toEqual([
      { role: "user", content: "what is up" },
    ]);
    expect(h.runCalls[0].opts.maxSteps).toBe(7);
    expect(h.runCalls[0].opts.scratchpadBytes).toBe(32 * 1024);
    expect(h.sessionCtorArgs[0].allowedScopes).toEqual(["read", "write"]);
    expect(h.sessionCtorArgs[0].command).toBe("node");
  });

  it("supports a remote transport and delegates audit creation", async () => {
    h.config = baseConfig({
      mcp: {
        remote: {
          url: "http://127.0.0.1:3010/mcp",
          scopes: ["read"],
        },
      },
    });

    await expect(ask("q")).resolves.toBe(0);

    expect(h.sessionCtorArgs[0]).toMatchObject({
      remote: {
        url: "http://127.0.0.1:3010/mcp",
        scopes: ["read"],
      },
      allowedScopes: ["read"],
    });
    expect(h.auditFiles).toEqual(["~/.openclaw/audit.jsonl"]);
  });

  it("closes the MCP session when the agent throws", async () => {
    h.runError = new Error("agent failed");

    await expect(ask("q")).rejects.toThrow("agent failed");
    expect(h.closed).toBe(1);
  });
});
