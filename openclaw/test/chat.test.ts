import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  /** Lines `rl.question()` yields, in order, before `endWith` is thrown. */
  lines: [] as string[],
  endWith: null as unknown,
  runCalls: [] as unknown[][],
  sessionCtorArgs: [] as Record<string, unknown>[],
  appended: [] as { file: string; data: string }[],
  replies: [] as string[],
  rlClosed: 0,
  sessionClosed: 0,
  started: 0,
}));

vi.mock("../src/config/load.js", () => ({ loadConfig: () => h.config }));

vi.mock("../src/providers/factory.js", () => ({
  resolveProvider: () => ({ tag: "provider" }),
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
      h.sessionClosed += 1;
    }
  },
}));

vi.mock("../src/core/agent.js", () => ({
  run: async (messages: unknown[], opts: Record<string, unknown>) => {
    // Snapshot the history as it was at call time — chat.ts mutates the array.
    h.runCalls.push(structuredClone(messages));
    (opts.onTextDelta as ((c: string) => void) | undefined)?.("streamed");
    return {
      finalText: h.replies[h.runCalls.length - 1] ?? "reply",
      steps: 1,
      stopReason: "end_turn",
    };
  },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => {
      const next = h.lines.shift();
      if (next === undefined) throw h.endWith;
      return next;
    },
    close: () => {
      h.rlClosed += 1;
    },
  }),
}));

vi.mock("node:os", () => ({ homedir: () => "/home/tester" }));
vi.mock("node:fs", () => ({
  mkdirSync: () => {},
  appendFileSync: (file: string, data: string) => {
    h.appended.push({ file, data });
  },
}));

const { chat } = await import("../src/cli/chat.js");

function eof(): Error & { code: string } {
  return Object.assign(new Error("closed"), { code: "ERR_USE_AFTER_CLOSE" });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: { type: "mock" },
    agent: { audit_file: "/tmp/audit.jsonl", max_steps: 5 },
    mcp: {
      local: { command: "node", args: [], env: {}, scopes: ["read"] },
    },
    ...overrides,
  };
}

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.config = baseConfig();
  h.lines = [];
  h.endWith = eof();
  h.runCalls.length = 0;
  h.sessionCtorArgs.length = 0;
  h.appended = [];
  h.replies = [];
  h.rlClosed = 0;
  h.sessionClosed = 0;
  h.started = 0;
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat without a local MCP", () => {
  it("refuses with exit code 1 and never starts a session", async () => {
    h.config = baseConfig({ mcp: {} });

    await expect(chat()).resolves.toBe(1);
    expect(stderr.mock.calls.at(0)?.[0]).toContain("No local MCP configured");
    expect(h.started).toBe(0);
  });
});

describe("chat conversation loop", () => {
  it("accumulates the conversation so each turn sees the previous exchange", async () => {
    h.lines = ["first question", "second question"];
    h.replies = ["first answer", "second answer"];

    await expect(chat()).resolves.toBe(0);

    expect(h.runCalls).toHaveLength(2);
    expect(h.runCalls[0]).toEqual([
      { role: "user", content: "first question" },
    ]);
    // The second turn must carry the first question AND the first answer.
    expect(h.runCalls[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
  });

  it("skips blank and whitespace-only lines without calling the agent", async () => {
    h.lines = ["", "   ", "\t", "real question"];

    await expect(chat()).resolves.toBe(0);

    expect(h.runCalls).toHaveLength(1);
    expect(h.runCalls[0]).toEqual([{ role: "user", content: "real question" }]);
  });

  it("streams each answer to stdout as it arrives", async () => {
    h.lines = ["a question"];

    await chat();

    expect(stdout.mock.calls.map((c) => c[0])).toContain("streamed");
  });

  it("greets with the configured provider type", async () => {
    h.config = baseConfig({ provider: { type: "anthropic" } });

    await chat();

    expect(stdout.mock.calls.at(0)?.[0]).toContain("chat with anthropic");
  });
});

describe("chat audit sink", () => {
  it("writes one JSON line per audited tool call and tolerates a write failure", async () => {
    h.lines = ["a question"];
    await chat();

    const sink = h.sessionCtorArgs[0].audit as (e: unknown) => void;
    sink({ tool: "notes.search", ok: true });

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].file).toBe("/tmp/audit.jsonl");
    expect(h.appended[0].data).toBe(
      JSON.stringify({ tool: "notes.search", ok: true }) + "\n",
    );

    h.appended.push = () => {
      throw new Error("EACCES");
    };
    expect(() => sink({ tool: "notes.create", ok: false })).not.toThrow();
  });

  it("expands a leading ~ in the audit path to the home directory", async () => {
    h.config = baseConfig({
      agent: { audit_file: "~/.openclaw/audit.jsonl", max_steps: 5 },
    });
    h.lines = ["a question"];
    await chat();

    const sink = h.sessionCtorArgs[0].audit as (e: unknown) => void;
    sink({ tool: "notes.search", ok: true });

    expect(h.appended[0].file).toBe("/home/tester/.openclaw/audit.jsonl");
  });
});

describe("chat shutdown", () => {
  it("exits quietly on Ctrl-D and releases both the readline and the session", async () => {
    h.lines = ["a question"];

    await expect(chat()).resolves.toBe(0);

    expect(h.rlClosed).toBe(1);
    expect(h.sessionClosed).toBe(1);
    const complaints = stderr.mock.calls.filter((c) =>
      String(c[0]).includes("chat ended"),
    );
    expect(complaints).toHaveLength(0);
  });

  it("reports an unexpected failure but still releases both resources", async () => {
    h.lines = ["a question"];
    h.endWith = new Error("stdin exploded");

    await expect(chat()).resolves.toBe(0);

    expect(stderr.mock.calls.at(-1)?.[0]).toContain(
      "chat ended: Error: stdin exploded",
    );
    expect(h.rlClosed).toBe(1);
    expect(h.sessionClosed).toBe(1);
  });
});
