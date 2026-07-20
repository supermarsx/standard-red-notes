import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "../src/config/schema.js";

const h = vi.hoisted(() => ({
  /** Tools the fake MCP server advertises. */
  tools: [] as { name: string; description?: string; inputSchema?: unknown }[],
  callResult: { isError: false, content: [{ type: "text", text: "ok" }] } as {
    isError: boolean;
    content: unknown;
  },
  callThrows: null as unknown,
  connectThrows: null as unknown,
  clientClosed: 0,
  clientCloseThrows: null as unknown,
  transportClosed: 0,
  transportPid: 4242 as number | undefined,
  transportOpts: [] as Record<string, unknown>[],
  stderrHandlers: [] as ((chunk: unknown) => void)[],
  connected: [] as unknown[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(transport: unknown) {
      if (h.connectThrows) throw h.connectThrows;
      h.connected.push(transport);
    }
    async listTools() {
      return { tools: h.tools };
    }
    async callTool() {
      if (h.callThrows) throw h.callThrows;
      return h.callResult;
    }
    async close() {
      h.clientClosed += 1;
      if (h.clientCloseThrows) throw h.clientCloseThrows;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = {
      on: (_event: string, handler: (chunk: unknown) => void) => {
        h.stderrHandlers.push(handler);
      },
    };
    constructor(opts: Record<string, unknown>) {
      h.transportOpts.push(opts);
    }
    get pid() {
      return h.transportPid;
    }
    async close() {
      h.transportClosed += 1;
    }
  },
}));

const { McpSession } = await import("../src/mcp/session.js");

type Audit = Parameters<
  ConstructorParameters<typeof McpSession>[0]["audit"]
>[0];

function makeSession(
  overrides: Partial<ConstructorParameters<typeof McpSession>[0]> = {},
) {
  const audited: Audit[] = [];
  const session = new McpSession({
    command: "node",
    args: ["mcp/dist/index.cjs"],
    allowedScopes: ["read", "write"] as Scope[],
    audit: (e) => audited.push(e),
    ...overrides,
  });
  return { session, audited };
}

beforeEach(() => {
  h.tools = [
    { name: "notes.search", description: "search", inputSchema: { a: 1 } },
    { name: "notes.create", description: "create" },
    { name: "users.ban", description: "ban" },
  ];
  h.callResult = { isError: false, content: [{ type: "text", text: "ok" }] };
  h.callThrows = null;
  h.connectThrows = null;
  h.clientCloseThrows = null;
  h.clientClosed = 0;
  h.transportClosed = 0;
  h.transportPid = 4242;
  h.transportOpts.length = 0;
  h.stderrHandlers.length = 0;
  h.connected.length = 0;
});

describe("McpSession.start", () => {
  it("spawns the configured command and builds the catalog", async () => {
    const { session } = makeSession();
    await session.start();

    expect(h.transportOpts[0].command).toBe("node");
    expect(h.transportOpts[0].args).toEqual(["mcp/dist/index.cjs"]);
    expect(h.connected).toHaveLength(1);
  });

  it("refuses to start twice", async () => {
    const { session } = makeSession();
    await session.start();

    await expect(session.start()).rejects.toThrow("session already started");
  });

  it("pipes child stderr only when a handler was supplied", async () => {
    const seen: string[] = [];
    const { session } = makeSession({ onStderr: (c) => seen.push(c) });
    await session.start();

    expect(h.transportOpts[0].stderr).toBe("pipe");
    h.stderrHandlers[0](Buffer.from("child noise"));
    expect(seen).toEqual(["child noise"]);
  });

  it("inherits child stderr when no handler was supplied", async () => {
    const { session } = makeSession();
    await session.start();

    expect(h.transportOpts[0].stderr).toBe("inherit");
    expect(h.stderrHandlers).toHaveLength(0);
  });

  it("tears the session down and rethrows when connect fails", async () => {
    h.connectThrows = new Error("spawn ENOENT");
    const { session } = makeSession();

    await expect(session.start()).rejects.toThrow("spawn ENOENT");
    // The half-open session must be released, not leaked.
    expect(h.transportClosed).toBe(1);
    expect(session.childPid()).toBeNull();
  });
});

describe("McpSession catalog", () => {
  it("defaults a missing tool description to the empty string", async () => {
    h.tools = [{ name: "notes.search" }];
    const { session } = makeSession();
    await session.start();

    expect(session.tools()[0].description).toBe("");
  });

  it("hides tools whose scope was not granted", async () => {
    const { session } = makeSession({ allowedScopes: ["read"] as Scope[] });
    await session.start();

    // notes.create is write and users.ban is admin — neither is granted.
    expect(session.tools().map((t) => t.name)).toEqual(["notes.search"]);
  });

  it("refuses to refresh before the session is started", async () => {
    const { session } = makeSession();

    await expect(session.refreshCatalog()).rejects.toThrow(
      "session not started",
    );
  });
});

describe("McpSession.childPid", () => {
  it("reports the spawned pid while running and null before start", async () => {
    const { session } = makeSession();
    expect(session.childPid()).toBeNull();

    await session.start();
    expect(session.childPid()).toBe(4242);
  });

  it("reports null when the transport has no pid yet", async () => {
    h.transportPid = undefined;
    const { session } = makeSession();
    await session.start();

    expect(session.childPid()).toBeNull();
  });
});

describe("McpSession.call", () => {
  it("refuses before the session is started", async () => {
    const { session } = makeSession();

    await expect(session.call("notes.search", {})).rejects.toThrow(
      "session not started",
    );
  });

  it("refuses a tool that is not in the catalog", async () => {
    const { session } = makeSession();
    await session.start();

    await expect(session.call("notes.nope", {})).rejects.toThrow(
      "tool not in catalog: notes.nope",
    );
  });

  it("refuses a catalogued tool whose scope was not granted", async () => {
    const { session } = makeSession({ allowedScopes: ["read"] as Scope[] });
    await session.start();

    await expect(session.call("notes.create", {})).rejects.toThrow(
      "tool notes.create requires scope write which is not granted",
    );
  });

  it("audits a successful call with the resolved scope and redacted payloads", async () => {
    const { session, audited } = makeSession();
    await session.start();

    await session.call("notes.create", {
      title: "hi",
      trace: "sk-abcd1234wxyz",
      body: "the full note text",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0].tool).toBe("notes.create");
    expect(audited[0].scope).toBe("write");
    expect(audited[0].ok).toBe(true);
    expect(audited[0].error).toBeUndefined();

    // Arguments and results both go through redactForAudit on the way out.
    const args = audited[0].argsRedacted as Record<string, unknown>;
    expect(args.title).toBe("hi");
    expect(args.trace).toBe("<redacted-token>");
    expect(args.body).toMatch(/^<note:/);
    expect(audited[0].resultRedacted).toBeDefined();
  });

  it("records ok=false when the server reports a tool error", async () => {
    h.callResult = { isError: true, content: [] };
    const { session, audited } = makeSession();
    await session.start();

    await session.call("notes.search", {});

    expect(audited[0].ok).toBe(false);
  });

  it("audits a thrown call as a failure and rethrows it", async () => {
    h.callThrows = new Error("transport died");
    const { session, audited } = makeSession();
    await session.start();

    await expect(session.call("notes.search", {})).rejects.toThrow(
      "transport died",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0].ok).toBe(false);
    expect(audited[0].error).toContain("transport died");
    expect(audited[0].resultRedacted).toBeUndefined();
  });
});

describe("McpSession.close", () => {
  it("closes client and transport and clears the catalog", async () => {
    const { session } = makeSession();
    await session.start();
    expect(session.tools().length).toBeGreaterThan(0);

    await session.close();

    expect(h.clientClosed).toBe(1);
    expect(h.transportClosed).toBe(1);
    expect(session.tools()).toEqual([]);
    expect(session.childPid()).toBeNull();
  });

  it("still closes the transport when closing the client throws", async () => {
    h.clientCloseThrows = new Error("client stuck");
    const { session } = makeSession();
    await session.start();

    await expect(session.close()).rejects.toThrow("client stuck");
    // The child process must be reaped even though the client close failed.
    expect(h.transportClosed).toBe(1);
  });

  it("is safe to call on a session that was never started", async () => {
    const { session } = makeSession();

    await expect(session.close()).resolves.toBeUndefined();
    expect(h.clientClosed).toBe(0);
    expect(h.transportClosed).toBe(0);
  });
});
