import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config/schema.js";
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
  remoteTransportOpts: [] as {
    url: string;
    opts: Record<string, unknown>;
  }[],
  remoteClosed: 0,
  remoteTerminated: 0,
  remoteTerminateThrows: null as unknown,
  remoteSessionId: "session-1" as string | undefined,
  stderrHandlers: [] as ((chunk: unknown) => void)[],
  connected: [] as { transport: unknown; options: unknown }[],
  listOptions: [] as unknown[],
  callRequests: [] as {
    request: unknown;
    options: unknown;
  }[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(transport: unknown, options: unknown) {
      if (h.connectThrows) throw h.connectThrows;
      h.connected.push({ transport, options });
    }
    async listTools(_params: unknown, options: unknown) {
      h.listOptions.push(options);
      return { tools: h.tools };
    }
    async callTool(request: unknown, _schema: unknown, options: unknown) {
      h.callRequests.push({ request, options });
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

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    sessionId = h.remoteSessionId;
    constructor(url: URL, opts: Record<string, unknown>) {
      h.remoteTransportOpts.push({ url: url.toString(), opts });
    }
    async terminateSession() {
      h.remoteTerminated += 1;
      if (h.remoteTerminateThrows) throw h.remoteTerminateThrows;
    }
    async close() {
      h.remoteClosed += 1;
    }
  },
}));

const { McpSession, sessionOptionsFromConfig } =
  await import("../src/mcp/session.js");

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
  h.remoteTransportOpts.length = 0;
  h.remoteClosed = 0;
  h.remoteTerminated = 0;
  h.remoteTerminateThrows = null;
  h.remoteSessionId = "session-1";
  h.stderrHandlers.length = 0;
  h.connected.length = 0;
  h.listOptions.length = 0;
  h.callRequests.length = 0;
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

  it("connects to remote Streamable HTTP with bearer auth and bounded retries", async () => {
    const { session } = makeSession({
      command: undefined,
      remote: {
        url: "http://127.0.0.1:3010/mcp",
        bearerToken: "test-secret",
      },
      timeoutMs: 4_321,
    });

    await session.start();

    expect(h.remoteTransportOpts[0].url).toBe("http://127.0.0.1:3010/mcp");
    const requestInit = h.remoteTransportOpts[0].opts.requestInit as {
      headers: Headers;
    };
    expect(requestInit.headers.get("authorization")).toBe("Bearer test-secret");
    expect(h.remoteTransportOpts[0].opts.reconnectionOptions).toMatchObject({
      maxRetries: 2,
      maxReconnectionDelay: 2_000,
    });
    expect(h.connected[0].options).toEqual({
      timeout: 4_321,
      maxTotalTimeout: 4_321,
    });
    expect(h.listOptions[0]).toEqual({
      timeout: 4_321,
      maxTotalTimeout: 4_321,
    });
    expect(session.childPid()).toBeNull();
  });

  it("rejects ambiguous, insecure, and unbounded direct session options", () => {
    expect(
      () =>
        new McpSession({
          allowedScopes: ["read"],
          audit: () => undefined,
        }),
    ).toThrow(/exactly one/);
    expect(
      () =>
        new McpSession({
          command: "node",
          remote: { url: "http://127.0.0.1:3010/mcp" },
          allowedScopes: ["read"],
          audit: () => undefined,
        }),
    ).toThrow(/exactly one/);
    expect(
      () =>
        new McpSession({
          remote: { url: "http://mcp.example.test/mcp" },
          allowedScopes: ["read"],
          audit: () => undefined,
        }),
    ).toThrow(/HTTPS and bearer/);
    expect(() => makeSession({ timeoutMs: 999 })).toThrow(/timeout/);
    expect(() => makeSession({ maxResponseBytes: 0 })).toThrow(
      /response limit/,
    );
  });
});

describe("sessionOptionsFromConfig", () => {
  it("maps local transport limits and explicit filesystem roots", () => {
    const previous = process.env.OPENCLAW_TEST_LOCAL_TOKEN;
    process.env.OPENCLAW_TEST_LOCAL_TOKEN = "local-runtime-secret";
    const cfg = configSchema.parse({
      provider: { type: "mock" },
      mcp: {
        local: {
          command: "custom-mcp",
          env: { MCP_TRANSPORT: "stdio" },
          env_from: ["OPENCLAW_TEST_LOCAL_TOKEN"],
          scopes: ["read", "files"],
          timeout_ms: 2_000,
          max_response_kb: 2,
        },
      },
      security: { allow_filesystem_paths: ["C:\\vault"] },
    });
    const audit = () => undefined;

    try {
      expect(sessionOptionsFromConfig(cfg, audit)).toMatchObject({
        command: "custom-mcp",
        env: {
          MCP_TRANSPORT: "stdio",
          OPENCLAW_TEST_LOCAL_TOKEN: "local-runtime-secret",
        },
        allowedScopes: ["read", "files"],
        allowedFilesystemPaths: ["C:\\vault"],
        timeoutMs: 2_000,
        maxResponseBytes: 2_048,
        audit,
      });
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_TEST_LOCAL_TOKEN;
      else process.env.OPENCLAW_TEST_LOCAL_TOKEN = previous;
    }
  });

  it("fails closed when an explicitly inherited local variable is missing", () => {
    const previous = process.env.OPENCLAW_TEST_LOCAL_MISSING;
    delete process.env.OPENCLAW_TEST_LOCAL_MISSING;
    try {
      const cfg = configSchema.parse({
        provider: { type: "mock" },
        mcp: {
          local: { env_from: ["OPENCLAW_TEST_LOCAL_MISSING"] },
        },
      });
      expect(() => sessionOptionsFromConfig(cfg, () => undefined)).toThrow(
        /local MCP environment variable is not set/,
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENCLAW_TEST_LOCAL_MISSING;
      else process.env.OPENCLAW_TEST_LOCAL_MISSING = previous;
    }
  });

  it("loads the remote bearer from the named environment variable", () => {
    const previous = process.env.OPENCLAW_TEST_MCP_TOKEN;
    process.env.OPENCLAW_TEST_MCP_TOKEN = "runtime-secret";
    try {
      const cfg = configSchema.parse({
        provider: { type: "mock" },
        mcp: {
          remote: {
            url: "https://mcp.example.test/mcp",
            allow_remote: true,
            bearer_env: "OPENCLAW_TEST_MCP_TOKEN",
          },
        },
      });

      expect(sessionOptionsFromConfig(cfg, () => undefined).remote).toEqual({
        url: "https://mcp.example.test/mcp",
        bearerToken: "runtime-secret",
      });
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_TEST_MCP_TOKEN;
      else process.env.OPENCLAW_TEST_MCP_TOKEN = previous;
    }
  });

  it("fails closed when a configured remote bearer is missing", () => {
    const previous = process.env.OPENCLAW_TEST_MISSING_TOKEN;
    delete process.env.OPENCLAW_TEST_MISSING_TOKEN;
    try {
      const cfg = configSchema.parse({
        provider: { type: "mock" },
        mcp: {
          remote: {
            url: "https://mcp.example.test/mcp",
            allow_remote: true,
            bearer_env: "OPENCLAW_TEST_MISSING_TOKEN",
          },
        },
      });

      expect(() => sessionOptionsFromConfig(cfg, () => undefined)).toThrow(
        /environment variable is not set/,
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENCLAW_TEST_MISSING_TOKEN;
      else process.env.OPENCLAW_TEST_MISSING_TOKEN = previous;
    }
  });

  it("rejects a config without either MCP transport", () => {
    const cfg = configSchema.parse({ provider: { type: "mock" } });
    expect(() => sessionOptionsFromConfig(cfg, () => undefined)).toThrow(
      /no MCP transport/,
    );
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

  it("rejects a catalog larger than the configured response limit", async () => {
    h.tools = [
      {
        name: "notes.search",
        description: "x".repeat(500),
      },
    ];
    const { session } = makeSession({ maxResponseBytes: 128 });

    await expect(session.start()).rejects.toThrow(/catalog exceeds/);
    expect(h.transportClosed).toBe(1);
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

  it("passes the configured timeout to tool calls", async () => {
    const { session } = makeSession({ timeoutMs: 2_345 });
    await session.start();

    await session.call("notes.search", { query: "budget" });

    expect(h.callRequests[0]).toMatchObject({
      request: {
        name: "notes.search",
        arguments: { query: "budget" },
      },
      options: {
        timeout: 2_345,
        maxTotalTimeout: 2_345,
      },
    });
  });

  it("rejects and audits a response larger than the configured limit", async () => {
    h.callResult = {
      isError: false,
      content: [{ type: "text", text: "x".repeat(2_000) }],
    };
    const { session, audited } = makeSession({ maxResponseBytes: 1_024 });
    await session.start();

    await expect(session.call("notes.search", {})).rejects.toThrow(
      /response exceeds/,
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      tool: "notes.search",
      ok: false,
    });
  });

  it("audits denied and pre-start invocations without leaking audit failures", async () => {
    const audit = vi.fn(() => {
      throw new Error("audit destination failed");
    });
    const session = new McpSession({
      command: "node",
      allowedScopes: ["read"],
      audit,
    });

    await expect(session.call("notes.search", {})).rejects.toThrow(
      "session not started",
    );
    expect(audit).toHaveBeenCalledOnce();

    await session.start();
    await expect(session.call("notes.create", {})).rejects.toThrow(
      /scope write/,
    );
    expect(audit).toHaveBeenCalledTimes(2);
  });
});

describe("McpSession filesystem confinement", () => {
  it("requires explicit local roots and canonical paths for filesystem tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-files-"));
    const outside = mkdtempSync(join(tmpdir(), "openclaw-outside-"));
    const input = join(root, "attachment.txt");
    const outsideInput = join(outside, "private.txt");
    writeFileSync(input, "inside");
    writeFileSync(outsideInput, "outside");
    h.tools = [{ name: "files.attach" }, { name: "export.create" }];
    try {
      const withoutRoots = makeSession({
        allowedScopes: ["files", "export"] as Scope[],
      }).session;
      await withoutRoots.start();
      expect(withoutRoots.tools()).toEqual([]);
      await expect(
        withoutRoots.call("files.attach", { path: input }),
      ).rejects.toThrow(/requires security\.allow_filesystem_paths/);

      const { session } = makeSession({
        allowedScopes: ["files", "export"] as Scope[],
        allowedFilesystemPaths: [root],
      });
      await session.start();
      expect(session.tools().map((tool) => tool.name)).toEqual([
        "files.attach",
        "export.create",
      ]);
      await expect(
        session.call("files.attach", { path: outsideInput }),
      ).rejects.toThrow(/outside the filesystem allowlist/);
      await expect(
        session.call("files.attach", { path: "relative.txt" }),
      ).rejects.toThrow(/must be an absolute path/);
      await expect(
        session.call("export.create", {
          outputPath: join(outside, "export.zip"),
        }),
      ).rejects.toThrow(/outside the filesystem allowlist/);

      await expect(session.call("files.attach", { path: input })).resolves.toBe(
        h.callResult,
      );
      await expect(
        session.call("export.create", {
          outputPath: join(root, "export.zip"),
        }),
      ).resolves.toBe(h.callResult);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects invalid roots, directories as attachments, and unsafe output links", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-files-"));
    const directory = join(root, "directory");
    mkdirSync(directory);
    h.tools = [{ name: "files.attach" }, { name: "export.create" }];
    try {
      expect(() =>
        makeSession({
          allowedScopes: ["files"] as Scope[],
          allowedFilesystemPaths: [join(root, "missing")],
        }),
      ).toThrow(/does not exist or cannot be resolved/);

      const { session } = makeSession({
        allowedScopes: ["files", "export"] as Scope[],
        allowedFilesystemPaths: [root],
      });
      await session.start();
      await expect(
        session.call("files.attach", { path: directory }),
      ).rejects.toThrow(/must be a regular file/);
      await expect(
        session.call("export.create", {
          outputPath: join(root, "missing", "export.zip"),
        }),
      ).rejects.toThrow(/could not be resolved safely/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never exposes or invokes filesystem tools over remote MCP", async () => {
    h.tools = [
      { name: "files.attach" },
      { name: "export.create" },
      { name: "notes.search" },
    ];
    const { session } = makeSession({
      command: undefined,
      remote: { url: "http://127.0.0.1:3010/mcp" },
      allowedScopes: ["read", "files", "export"] as Scope[],
      allowedFilesystemPaths: ["Z:\\does-not-need-to-exist"],
    });

    await session.start();

    expect(session.tools().map((tool) => tool.name)).toEqual(["notes.search"]);
    await expect(
      session.call("files.attach", { path: "C:\\private.txt" }),
    ).rejects.toThrow(/disabled over remote/);
    expect(h.callRequests).toHaveLength(0);
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

  it("terminates and closes an active remote session", async () => {
    const { session } = makeSession({
      command: undefined,
      remote: { url: "http://127.0.0.1:3010/mcp" },
    });
    await session.start();

    await session.close();

    expect(h.remoteTerminated).toBe(1);
    expect(h.remoteClosed).toBe(1);
    expect(h.transportClosed).toBe(0);
  });

  it("still closes remote transport when session termination fails", async () => {
    h.remoteTerminateThrows = new Error("already expired");
    const { session } = makeSession({
      command: undefined,
      remote: { url: "http://127.0.0.1:3010/mcp" },
    });
    await session.start();

    await expect(session.close()).resolves.toBeUndefined();
    expect(h.remoteTerminated).toBe(1);
    expect(h.remoteClosed).toBe(1);
  });
});
