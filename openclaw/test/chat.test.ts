import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  /** Lines `rl.question()` yields, in order, before `endWith` is thrown. */
  lines: [] as string[],
  endWith: null as unknown,
  createError: undefined as Error | undefined,
  runCalls: [] as unknown[][],
  runOpts: [] as Record<string, unknown>[],
  sessionCtorArgs: [] as Record<string, unknown>[],
  auditFiles: [] as string[],
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
      h.sessionClosed += 1;
    }
  },
}));

vi.mock("../src/core/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/agent.js")>();
  return {
    ...actual,
    run: async (messages: unknown[], opts: Record<string, unknown>) => {
      // Snapshot the history as it was at call time — chat.ts mutates the array.
      h.runCalls.push(structuredClone(messages));
      h.runOpts.push(opts);
      (opts.onTextDelta as ((c: string) => void) | undefined)?.("streamed");
      return {
        finalText: h.replies[h.runCalls.length - 1] ?? "reply",
        steps: 1,
        stopReason: "end_turn",
      };
    },
  };
});

vi.mock("../src/util/audit.js", () => ({
  createAuditSink: (file: string) => {
    h.auditFiles.push(file);
    return () => undefined;
  },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => {
    if (h.createError) throw h.createError;
    return {
      question: async () => {
        const next = h.lines.shift();
        if (next === undefined) throw h.endWith;
        return next;
      },
      close: () => {
        h.rlClosed += 1;
      },
    };
  },
}));

const { chat } = await import("../src/cli/chat.js");

function eof(): Error & { code: string } {
  return Object.assign(new Error("closed"), { code: "ERR_USE_AFTER_CLOSE" });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: { type: "mock" },
    agent: {
      audit_file: "/tmp/audit.jsonl",
      max_steps: 5,
      scratchpad_kb: 4,
    },
    security: { allow_filesystem_paths: [] },
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
  h.createError = undefined;
  h.runCalls.length = 0;
  h.runOpts.length = 0;
  h.sessionCtorArgs.length = 0;
  h.auditFiles.length = 0;
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

describe("chat without an MCP transport", () => {
  it("refuses with exit code 1 and never starts a session", async () => {
    h.config = baseConfig({ mcp: {} });

    await expect(chat()).resolves.toBe(1);
    expect(stderr.mock.calls.at(0)?.[0]).toContain("No MCP configured");
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

  it("passes the configured scratchpad bound and audit path", async () => {
    h.lines = ["a question"];
    await chat();

    expect(h.runOpts[0].scratchpadBytes).toBe(4 * 1024);
    expect(h.auditFiles).toEqual(["/tmp/audit.jsonl"]);
  });

  it("keeps persistent chat history within the scratchpad bound", async () => {
    h.lines = ["x".repeat(5_000), "second"];
    await chat();

    expect(
      Buffer.byteLength(JSON.stringify(h.runCalls[1]), "utf8"),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(JSON.stringify(h.runCalls[1])).toContain("second");
  });

  it("supports a remote MCP transport", async () => {
    h.config = baseConfig({
      mcp: {
        remote: {
          url: "http://127.0.0.1:3010/mcp",
          scopes: ["read"],
        },
      },
    });
    h.lines = ["status"];

    await expect(chat()).resolves.toBe(0);
    expect(h.sessionCtorArgs[0]).toMatchObject({
      remote: {
        url: "http://127.0.0.1:3010/mcp",
        scopes: ["read"],
      },
      allowedScopes: ["read"],
    });
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

  it("releases the session if readline initialization fails", async () => {
    h.createError = new Error("readline unavailable");

    await expect(chat()).resolves.toBe(0);

    expect(h.sessionClosed).toBe(1);
    expect(h.rlClosed).toBe(0);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain("readline unavailable");
  });
});
