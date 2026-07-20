import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  runResult: {
    finalText: "answer",
    steps: 2,
    stopReason: "end_turn" as "end_turn" | "max_steps" | "error",
  },
  runCalls: [] as { messages: unknown; opts: Record<string, unknown> }[],
  sessionCtorArgs: [] as Record<string, unknown>[],
  started: 0,
  closed: 0,
  appended: [] as { file: string; data: string }[],
  mkdirs: [] as string[],
}));

vi.mock("../src/config/load.js", () => ({
  loadConfig: () => h.config,
}));

vi.mock("../src/providers/factory.js", () => ({
  resolveProvider: (spec: unknown) => ({ tag: "provider", spec }),
}));

vi.mock("../src/mcp/session.js", () => ({
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

vi.mock("../src/core/agent.js", () => ({
  run: async (messages: unknown, opts: Record<string, unknown>) => {
    h.runCalls.push({ messages, opts });
    const onTextDelta = opts.onTextDelta as ((c: string) => void) | undefined;
    onTextDelta?.("chunk-1");
    onTextDelta?.("chunk-2");
    return h.runResult;
  },
}));

vi.mock("node:os", () => ({ homedir: () => "/home/tester" }));

vi.mock("node:fs", () => ({
  mkdirSync: (dir: string) => {
    h.mkdirs.push(dir);
  },
  appendFileSync: (file: string, data: string) => {
    h.appended.push({ file, data });
  },
}));

const { ask } = await import("../src/cli/ask.js");

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: { type: "mock" },
    agent: { audit_file: "~/.openclaw/audit.jsonl", max_steps: 7 },
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
  h.runCalls.length = 0;
  h.sessionCtorArgs.length = 0;
  h.appended.length = 0;
  h.mkdirs.length = 0;
  h.started = 0;
  h.closed = 0;
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask without a local MCP", () => {
  it("refuses with exit code 1 and does not start a session or call the agent", async () => {
    h.config = baseConfig({ mcp: {} });

    const code = await ask("what is up");

    expect(code).toBe(1);
    expect(stderr.mock.calls.at(0)?.[0]).toContain("No local MCP configured");
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
    expect(h.sessionCtorArgs[0].allowedScopes).toEqual(["read", "write"]);
    expect(h.sessionCtorArgs[0].command).toBe("node");
  });
});

describe("ask audit sink", () => {
  it("expands a leading ~ to the home directory and creates the parent directory", async () => {
    await ask("q");

    const sink = h.sessionCtorArgs[0].audit as (e: unknown) => void;
    sink({ tool: "notes.search", ok: true });

    expect(h.mkdirs).toEqual(["/home/tester/.openclaw"]);
    expect(h.appended[0].file).toBe("/home/tester/.openclaw/audit.jsonl");
  });

  it("leaves an absolute audit path untouched and appends one JSON line per entry", async () => {
    h.config = baseConfig({
      agent: { audit_file: "/var/log/openclaw.jsonl", max_steps: 7 },
    });

    await ask("q");
    const sink = h.sessionCtorArgs[0].audit as (e: unknown) => void;
    sink({ tool: "notes.create", ok: false });
    sink({ tool: "notes.delete", ok: true });

    expect(h.appended.map((a) => a.file)).toEqual([
      "/var/log/openclaw.jsonl",
      "/var/log/openclaw.jsonl",
    ]);
    expect(h.appended[0].data).toBe(
      JSON.stringify({ tool: "notes.create", ok: false }) + "\n",
    );
    expect(h.appended[1].data.endsWith("\n")).toBe(true);
  });

  it("survives an unwritable audit file rather than failing the question", async () => {
    await ask("q");
    const sink = h.sessionCtorArgs[0].audit as (e: unknown) => void;
    h.appended.push = () => {
      throw new Error("EACCES");
    };

    expect(() => sink({ tool: "notes.search", ok: true })).not.toThrow();
  });
});
