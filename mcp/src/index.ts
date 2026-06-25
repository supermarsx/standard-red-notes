#!/usr/bin/env node
import "./polyfill.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { bootstrapHeadlessApp, type HeadlessApp } from "./snjs/bootstrap.js";
import { SnjsBackedClient } from "./snjs/SnjsBackedClient.js";

// Transport selection. `stdio` (default) preserves the original single-client
// behavior. `http` runs the bridge as a long-lived, authenticated network
// service (an always-on tooling side-car behind compose).
const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const httpPort = process.env.MCP_HTTP_PORT
  ? Number(process.env.MCP_HTTP_PORT)
  : 3010;
const httpToken = process.env.MCP_HTTP_TOKEN;

const serverUrl =
  process.env.STANDARD_RED_NOTES_SERVER_URL ?? "http://localhost:3000";
// MCP scoped token: when set, the bridge authenticates with this token INSTEAD
// of email/password/MFA. Its scope (read vs read-write) is enforced below.
const mcpToken = process.env.STANDARD_RED_NOTES_MCP_TOKEN;
let allowWrites = process.env.STANDARD_RED_NOTES_ALLOW_WRITES === "1";
const email = process.env.STANDARD_RED_NOTES_EMAIL;
const password = process.env.STANDARD_RED_NOTES_PASSWORD;
const mfaCode = process.env.STANDARD_RED_NOTES_MFA_CODE;
const dataDir =
  process.env.STANDARD_RED_NOTES_DATA_DIR ?? "/var/lib/standard-red-notes-mcp";
const allowRegister = process.env.STANDARD_RED_NOTES_ALLOW_REGISTER === "1";
const syncIntervalMs = process.env.STANDARD_RED_NOTES_SYNC_INTERVAL_MS
  ? Number(process.env.STANDARD_RED_NOTES_SYNC_INTERVAL_MS)
  : 10_000;

let headless: HeadlessApp | undefined;
let client: SnjsBackedClient | undefined;
let initPromise: Promise<SnjsBackedClient> | undefined;

// Lazily bootstrap snjs and sign into the account on first use. Memoized so the
// expensive launch+sync happens once. `status` works without credentials.
function getClient(): Promise<SnjsBackedClient> {
  if (client) {
    return Promise.resolve(client);
  }
  if (!initPromise) {
    initPromise = (async () => {
      if (!mcpToken && (!email || !password)) {
        throw new Error(
          "Account not configured. Set STANDARD_RED_NOTES_MCP_TOKEN, or STANDARD_RED_NOTES_EMAIL and STANDARD_RED_NOTES_PASSWORD.",
        );
      }
      headless = await bootstrapHeadlessApp({
        serverUrl,
        dataDir,
        mfaCode,
        password,
        syncIntervalMs,
      });
      if (mcpToken) {
        // Token path: authenticate with the scoped token (no email/password).
        // A read-only token forcibly disables writes regardless of the
        // STANDARD_RED_NOTES_ALLOW_WRITES env, so the bridge never attempts a
        // write the server would reject.
        const result = await headless.signInWithToken(mcpToken);
        if (result.readOnly) {
          allowWrites = false;
        }
      } else if (!headless.isSignedIn()) {
        if (allowRegister) {
          await headless.register(email as string, password as string);
        } else {
          await headless.signIn(email as string, password as string, mfaCode);
        }
      } else {
        await headless.sync();
      }
      // Continuously pick up collaborators' changes (shared vaults, other
      // sessions) without waiting for the next tool call.
      headless.startSyncLoop();
      client = new SnjsBackedClient(headless, { allowWrites, baseUrl: serverUrl });
      return client;
    })().catch((error) => {
      // Don't cache a rejected init — a transient sign-in/network failure would
      // otherwise brick every subsequent tool call until the process restarts.
      // Tear down any half-initialized app so the next call starts clean.
      initPromise = undefined;
      void headless?.deinit().catch(() => {});
      headless = undefined;
      throw error;
    });
  }
  return initPromise;
}

// Build a fresh McpServer with all tools registered. The protocol/session state
// lives on the McpServer instance, so HTTP mode creates one per client session;
// stdio mode uses a single instance. The underlying account/headless client
// (getClient) is shared module-level state across all sessions — they all act on
// the same authenticated account.
function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "standard-red-notes",
      version: "0.3.0",
    },
    {
      instructions:
        "Standard Red Notes MCP bridge. Operates on a real, end-to-end-encrypted account via an embedded headless snjs client: notes and tags are decrypted locally and changes sync back encrypted. Configure STANDARD_RED_NOTES_EMAIL/_PASSWORD/_SERVER_URL. Write tools require STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    },
  );

  server.registerTool(
  "standard_red_notes_status",
  {
    title: "Standard Red Notes Status",
    description: "Report MCP bridge status, server URL, and account sign-in state.",
    inputSchema: {},
    outputSchema: {
      status: z.string(),
      transport: z.string(),
      serverUrl: z.string(),
      writes: z.boolean(),
      accountConfigured: z.boolean(),
      signedIn: z.boolean(),
      syncHealthy: z.boolean(),
      consecutiveSyncFailures: z.number(),
      lastSyncError: z.string().optional(),
    },
  },
  async () => {
    const accountConfigured = Boolean(mcpToken || (email && password));
    let signedIn = false;
    try {
      if (accountConfigured) {
        await getClient();
        signedIn = headless?.isSignedIn() ?? false;
      }
    } catch {
      signedIn = false;
    }
    const health = headless?.getSyncHealth() ?? { consecutiveFailures: 0 };
    const structuredContent = {
      status: "ready",
      transport: transportMode,
      serverUrl,
      writes: allowWrites,
      accountConfigured,
      signedIn,
      // A signed-in bridge whose background sync keeps failing is a "zombie":
      // it looks fine but no data moves. Surface that explicitly.
      syncHealthy: signedIn && health.consecutiveFailures < 3,
      consecutiveSyncFailures: health.consecutiveFailures,
      ...(health.lastError ? { lastSyncError: health.lastError } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

server.registerTool(
  "notes.list",
  {
    title: "List Notes",
    description:
      "List recent notes (UUID, title, updatedAt), newest first. Bodies are not included.",
    inputSchema: {
      limit: z.number().int().positive().max(200).default(50),
      cursor: z.string().optional(),
    },
    outputSchema: {
      notes: z.array(
        z.object({ uuid: z.string(), title: z.string(), updatedAt: z.string() }),
      ),
      cursor: z.string().optional(),
    },
  },
  async ({ limit, cursor }) => {
    const result = await (await getClient()).listNotes(limit, cursor);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "notes.search",
  {
    title: "Search Notes",
    description: "Search notes by title or body keywords. Returns UUID, title, snippet.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).default(10),
    },
    outputSchema: {
      hits: z.array(
        z.object({ uuid: z.string(), title: z.string(), snippet: z.string() }),
      ),
    },
  },
  async ({ query, limit }) => {
    const result = await (await getClient()).searchNotes(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "notes.read",
  {
    title: "Read Note",
    description: "Fetch a single note by UUID: title, body, tags, timestamps.",
    inputSchema: { uuid: z.string().uuid() },
    outputSchema: {
      uuid: z.string(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
      vault: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    },
  },
  async ({ uuid }) => {
    const note = await (await getClient()).readNote(uuid);
    return {
      content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
      structuredContent: note as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "notes.create",
  {
    title: "Create Note",
    description:
      "Create a new note. Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: {
      title: z.string().min(1),
      body: z.string().default(""),
      tags: z.array(z.string()).default([]),
      vault: z
        .string()
        .optional()
        .describe("Optional vault UUID to place the note in (use vaults.list)."),
    },
    outputSchema: { uuid: z.string(), title: z.string() },
  },
  async ({ title, body, tags, vault }) => {
    const created = await (await getClient()).createNote({ title, body, tags, vault });
    return {
      content: [{ type: "text", text: JSON.stringify(created, null, 2) }],
      structuredContent: created as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "notes.update",
  {
    title: "Update Note",
    description: "Update an existing note by UUID. Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: {
      uuid: z.string().uuid(),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    outputSchema: { uuid: z.string(), updatedAt: z.string() },
  },
  async ({ uuid, title, body, tags }) => {
    const updated = await (await getClient()).updateNote(uuid, { title, body, tags });
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
      structuredContent: updated as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "notes.delete",
  {
    title: "Delete Note",
    description: "Delete a note by UUID. Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: { uuid: z.string().uuid() },
    outputSchema: { uuid: z.string(), deleted: z.boolean() },
  },
  async ({ uuid }) => {
    await (await getClient()).deleteNote(uuid);
    return {
      content: [{ type: "text", text: JSON.stringify({ uuid, deleted: true }) }],
      structuredContent: { uuid, deleted: true },
    };
  },
);

server.registerTool(
  "tags.list",
  {
    title: "List Tags",
    description: "List tags in the account.",
    inputSchema: {},
    outputSchema: {
      tags: z.array(z.object({ uuid: z.string(), title: z.string() })),
    },
  },
  async () => {
    const tags = await (await getClient()).listTags();
    return {
      content: [{ type: "text", text: JSON.stringify({ tags }, null, 2) }],
      structuredContent: { tags },
    };
  },
);

server.registerTool(
  "vaults.list",
  {
    title: "List Vaults",
    description:
      "List vaults in the account (UUID, name, and whether it is a shared/collaborative vault).",
    inputSchema: {},
    outputSchema: {
      vaults: z.array(
        z.object({ uuid: z.string(), name: z.string(), shared: z.boolean() }),
      ),
    },
  },
  async () => {
    const vaults = await (await getClient()).listVaults();
    return {
      content: [{ type: "text", text: JSON.stringify({ vaults }, null, 2) }],
      structuredContent: { vaults },
    };
  },
);

server.registerTool(
  "vaults.create",
  {
    title: "Create Vault",
    description:
      "Create a new vault (for grouping/collaborating on notes). Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: {
      name: z.string().min(1),
      description: z.string().optional(),
    },
    outputSchema: { uuid: z.string(), name: z.string(), shared: z.boolean() },
  },
  async ({ name, description }) => {
    const vault = await (await getClient()).createVault(name, description);
    return {
      content: [{ type: "text", text: JSON.stringify(vault, null, 2) }],
      structuredContent: vault as unknown as Record<string, unknown>,
    };
  },
);

  return server;
}

// ---------------------------------------------------------------------------
// Transport bootstrap
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Constant-time bearer-token check. Returns true only when the request carries
// `Authorization: Bearer <token>` exactly matching MCP_HTTP_TOKEN. Uses
// timingSafeEqual to avoid leaking the token via response timing.
function isAuthorized(req: IncomingMessage): boolean {
  if (!httpToken) return false;
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(httpToken);
  // timingSafeEqual throws on length mismatch; guard so a wrong-length token is
  // a normal rejection, not a 500, while still comparing in constant time.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    "content-type": "application/json",
    ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
  });
  res.end(body);
}

async function startHttp(): Promise<void> {
  // FAIL CLOSED: an autonomous HTTP MCP endpoint exposes powerful note
  // read/write tools, so it must never serve unauthenticated. Refuse to start
  // without a token rather than silently exposing the account.
  if (!httpToken) {
    console.error(
      "[mcp] FATAL: MCP_TRANSPORT=http requires MCP_HTTP_TOKEN to be set. " +
        "Refusing to start an unauthenticated MCP endpoint. Set MCP_HTTP_TOKEN " +
        "to a strong secret and pass it as 'Authorization: Bearer <token>'.",
    );
    process.exit(1);
  }
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
    console.error(`[mcp] FATAL: invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
    process.exit(1);
  }

  // One Streamable HTTP transport (and McpServer) per session. The session id is
  // generated on initialize and echoed back via the `mcp-session-id` header; the
  // client must send it on subsequent requests. State is in-memory.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, transports).catch((error) => {
      console.error("[mcp] request handler error:", error);
      if (!res.headersSent) {
        sendJsonError(res, 500, -32603, "Internal server error");
      } else {
        try {
          res.end();
        } catch {
          /* already torn down */
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(httpPort, "0.0.0.0", () => resolve());
  });
  console.error(
    `[mcp] Streamable HTTP transport listening on 0.0.0.0:${httpPort} (POST/GET/DELETE /mcp, bearer-authenticated)`,
  );

  // Close active sessions on shutdown so in-flight streams end cleanly.
  httpShutdownHook = async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const transport of transports.values()) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
    }
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  // Only the MCP endpoint is served. A simple unauthenticated liveness probe is
  // intentionally NOT exposed to keep the surface minimal — compose can probe
  // the TCP port instead.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/mcp") {
    sendJsonError(res, 404, -32601, "Not found");
    return;
  }

  // Auth gate FIRST, before any MCP/session processing.
  if (!isAuthorized(req)) {
    sendJsonError(res, 401, -32001, "Unauthorized: missing or invalid bearer token");
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(req, res);
    return;
  }

  // No existing session. Only an `initialize` POST may open one; other methods
  // without a valid session are rejected by the transport itself.
  if (req.method !== "POST") {
    sendJsonError(res, 400, -32000, "Bad Request: no valid session id");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

let httpShutdownHook: (() => Promise<void>) | undefined;

async function start(): Promise<void> {
  if (transportMode === "http") {
    await startHttp();
  } else if (transportMode === "stdio") {
    await startStdio();
  } else {
    console.error(
      `[mcp] FATAL: unknown MCP_TRANSPORT '${transportMode}'. Use 'stdio' or 'http'.`,
    );
    process.exit(1);
  }
}

// Flush pending storage/keychain writes before the process exits (container stop,
// Ctrl-C) so an in-flight write isn't dropped, leaving local state stale/corrupt.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await httpShutdownHook?.();
  } catch {
    /* best-effort */
  }
  try {
    await headless?.deinit();
  } catch {
    /* best-effort */
  }
  process.exit(signal === "uncaught" ? 1 : 0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void start();
