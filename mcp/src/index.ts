#!/usr/bin/env node
import "./polyfill.js";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  bootstrapHeadlessApp,
  isUnauthorizedError,
  type HeadlessApp,
} from "./snjs/bootstrap.js";
import { SnjsBackedClient } from "./snjs/SnjsBackedClient.js";
import type { McpScope } from "./snjs/tokenAuth.js";
import { rootsFromEnvironment } from "./security/filesystem.js";
import {
  assertSafeHttpBinding,
  HttpInputError,
  isBearerAuthorized,
  isInitializeRequest,
  parseBoundedInteger,
  readBoundedJsonBody,
  withHttpRequestTimeout,
} from "./httpSecurity.js";

// Transport selection. `stdio` (default) preserves the original single-client
// behavior. `http` runs the bridge as a long-lived, authenticated network
// service (an always-on tooling side-car behind compose).
const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const httpPort = process.env.MCP_HTTP_PORT
  ? Number(process.env.MCP_HTTP_PORT)
  : 3010;
const httpHost = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
const httpToken = process.env.MCP_HTTP_TOKEN;
const httpAllowRemote = process.env.MCP_HTTP_ALLOW_REMOTE === "1";
const httpMaxBodyBytes = parseBoundedInteger(
  process.env.MCP_HTTP_MAX_BODY_BYTES,
  1024 * 1024,
  { min: 1024, max: 16 * 1024 * 1024, name: "MCP_HTTP_MAX_BODY_BYTES" },
);
const httpMaxSessions = parseBoundedInteger(
  process.env.MCP_HTTP_MAX_SESSIONS,
  32,
  { min: 1, max: 1024, name: "MCP_HTTP_MAX_SESSIONS" },
);
const httpSessionIdleMs = parseBoundedInteger(
  process.env.MCP_HTTP_SESSION_IDLE_MS,
  5 * 60_000,
  { min: 10_000, max: 24 * 60 * 60_000, name: "MCP_HTTP_SESSION_IDLE_MS" },
);
const httpBodyTimeoutMs = parseBoundedInteger(
  process.env.MCP_HTTP_BODY_TIMEOUT_MS,
  10_000,
  { min: 1_000, max: 120_000, name: "MCP_HTTP_BODY_TIMEOUT_MS" },
);
const httpRequestTimeoutMs = parseBoundedInteger(
  process.env.MCP_HTTP_REQUEST_TIMEOUT_MS,
  60_000,
  { min: 1_000, max: 10 * 60_000, name: "MCP_HTTP_REQUEST_TIMEOUT_MS" },
);

// Default for a bridge running ON THE HOST: the compose stack's single front
// door (app nginx on :3001), which proxies /v1|/v2|/auth to the api-gateway —
// the gateway itself publishes no host port. Inside compose this is overridden
// to the internal URL (http://server:3000) via docker-compose.yml.
const serverUrl =
  process.env.STANDARD_RED_NOTES_SERVER_URL ?? "http://localhost:3001";
// MCP scoped token: when set, the bridge authenticates with this token INSTEAD
// of email/password/MFA. Its scope (read vs read-write) is enforced below.
const mcpToken = process.env.STANDARD_RED_NOTES_MCP_TOKEN;
const configuredAllowWrites =
  process.env.STANDARD_RED_NOTES_ALLOW_WRITES === "1";
const email = process.env.STANDARD_RED_NOTES_EMAIL;
const password = process.env.STANDARD_RED_NOTES_PASSWORD;
const mfaCode = process.env.STANDARD_RED_NOTES_MFA_CODE;
const dataDir =
  process.env.STANDARD_RED_NOTES_DATA_DIR ?? "/var/lib/standard-red-notes-mcp";
const allowRegister = process.env.STANDARD_RED_NOTES_ALLOW_REGISTER === "1";
const syncIntervalMs = process.env.STANDARD_RED_NOTES_SYNC_INTERVAL_MS
  ? Number(process.env.STANDARD_RED_NOTES_SYNC_INTERVAL_MS)
  : 10_000;
const fileRoots = rootsFromEnvironment(
  process.env.STANDARD_RED_NOTES_FILE_ROOTS,
);
const exportRoots = rootsFromEnvironment(
  process.env.STANDARD_RED_NOTES_EXPORT_ROOTS,
);
const maxAttachmentBytes = parseBoundedInteger(
  process.env.STANDARD_RED_NOTES_MAX_ATTACHMENT_BYTES,
  16 * 1024 * 1024,
  {
    min: 1,
    max: 1024 * 1024 * 1024,
    name: "STANDARD_RED_NOTES_MAX_ATTACHMENT_BYTES",
  },
);
const maxExportBytes = parseBoundedInteger(
  process.env.STANDARD_RED_NOTES_MAX_EXPORT_BYTES,
  128 * 1024 * 1024,
  {
    min: 1024,
    max: 2 * 1024 * 1024 * 1024,
    name: "STANDARD_RED_NOTES_MAX_EXPORT_BYTES",
  },
);

let headless: HeadlessApp | undefined;
let client: SnjsBackedClient | undefined;
let initPromise: Promise<SnjsBackedClient> | undefined;
let activeScope: McpScope | undefined;

function diagnosticMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [mcpToken, password, httpToken]) {
    if (secret) {
      message = message.replaceAll(secret, "<redacted>");
    }
  }
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .slice(0, 1_000);
}

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
      let created: HeadlessApp | undefined;
      created = await bootstrapHeadlessApp({
        serverUrl,
        dataDir,
        mfaCode,
        password,
        syncIntervalMs,
        onUnauthorized: () => {
          if (headless === created) {
            headless = undefined;
            client = undefined;
            initPromise = undefined;
            activeScope = undefined;
          }
        },
      });
      headless = created;
      let effectiveWrites = configuredAllowWrites;
      if (mcpToken) {
        // Token path: authenticate with the scoped token (no email/password).
        // A read-only token forcibly disables writes regardless of the
        // STANDARD_RED_NOTES_ALLOW_WRITES env, so the bridge never attempts a
        // write the server would reject.
        const result = await created.signInWithToken(mcpToken);
        activeScope = result.scope;
        if (result.readOnly) {
          effectiveWrites = false;
        }
      } else if (!created.isSignedIn()) {
        if (allowRegister) {
          await created.register(email as string, password as string);
        } else {
          await created.signIn(email as string, password as string, mfaCode);
        }
      } else {
        await created.sync();
      }
      // Continuously pick up collaborators' changes (shared vaults, other
      // sessions) without waiting for the next tool call.
      created.startSyncLoop();
      client = new SnjsBackedClient(created, {
        allowWrites: effectiveWrites,
        baseUrl: serverUrl,
        allowedTagUuids: activeScope?.tagUuids,
        fileRoots,
        exportRoots,
        maxAttachmentBytes,
        maxExportBytes,
      });
      return client;
    })().catch((error) => {
      // Don't cache a rejected init — a transient sign-in/network failure would
      // otherwise brick every subsequent tool call until the process restarts.
      // Tear down any half-initialized app so the next call starts clean.
      initPromise = undefined;
      const failed = headless;
      if (failed) {
        void (
          isUnauthorizedError(error) ? failed.wipe() : failed.deinit()
        ).catch(() => {});
      }
      headless = undefined;
      client = undefined;
      activeScope = undefined;
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
      description:
        "Report MCP bridge status, server URL, and account sign-in state.",
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
        lastSuccessfulSyncAt: z.string().optional(),
        authorizationLost: z.boolean(),
        initializationError: z.string().optional(),
        tagScope: z.object({
          restricted: z.boolean(),
          enforcement: z.literal("client-side-advisory"),
          cryptographic: z.literal(false),
          tagUuids: z.array(z.string()).optional(),
        }),
      },
    },
    async () => {
      const accountConfigured = Boolean(mcpToken || (email && password));
      let signedIn = false;
      let initializationError: string | undefined;
      let initializedClient: SnjsBackedClient | undefined;
      try {
        if (accountConfigured) {
          initializedClient = await getClient();
          signedIn = headless?.isSignedIn() ?? false;
        }
      } catch (error) {
        signedIn = false;
        initializationError = diagnosticMessage(error);
      }
      const health = headless?.getSyncHealth() ?? {
        consecutiveFailures: 0,
        authorizationLost: false,
      };
      const tagScope =
        initializedClient?.accountStatus().tagScope ??
        ({
          restricted: activeScope?.tagUuids !== undefined,
          enforcement: "client-side-advisory",
          cryptographic: false,
          ...(activeScope?.tagUuids
            ? { tagUuids: [...activeScope.tagUuids].sort() }
            : {}),
        } as const);
      const structuredContent = {
        status:
          accountConfigured && (!signedIn || health.authorizationLost)
            ? "degraded"
            : "ready",
        transport: transportMode,
        serverUrl,
        writes: initializedClient?.allowWrites ?? configuredAllowWrites,
        accountConfigured,
        signedIn,
        // A signed-in bridge whose background sync keeps failing is a "zombie":
        // it looks fine but no data moves. Surface that explicitly.
        syncHealthy: signedIn && health.consecutiveFailures < 3,
        consecutiveSyncFailures: health.consecutiveFailures,
        authorizationLost: health.authorizationLost,
        ...(health.lastError
          ? { lastSyncError: diagnosticMessage(health.lastError) }
          : {}),
        ...(health.lastSuccessfulSyncAt
          ? { lastSuccessfulSyncAt: health.lastSuccessfulSyncAt }
          : {}),
        ...(initializationError ? { initializationError } : {}),
        tagScope,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
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
          z.object({
            uuid: z.string(),
            title: z.string(),
            updatedAt: z.string(),
          }),
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
      description:
        "Search notes by title or body keywords. Returns UUID, title, snippet.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).default(10),
      },
      outputSchema: {
        hits: z.array(
          z.object({
            uuid: z.string(),
            title: z.string(),
            snippet: z.string(),
          }),
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
      description:
        "Fetch a single note by UUID: title, body, tags, timestamps.",
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
          .describe(
            "Optional vault UUID to place the note in (use vaults.list).",
          ),
      },
      outputSchema: { uuid: z.string(), title: z.string() },
    },
    async ({ title, body, tags, vault }) => {
      const created = await (
        await getClient()
      ).createNote({ title, body, tags, vault });
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
      description:
        "Update an existing note by UUID. Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
      inputSchema: {
        uuid: z.string().uuid(),
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      outputSchema: { uuid: z.string(), updatedAt: z.string() },
    },
    async ({ uuid, title, body, tags }) => {
      const updated = await (
        await getClient()
      ).updateNote(uuid, { title, body, tags });
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
      description:
        "Delete a note by UUID. Requires STANDARD_RED_NOTES_ALLOW_WRITES=1.",
      inputSchema: { uuid: z.string().uuid() },
      outputSchema: { uuid: z.string(), deleted: z.boolean() },
    },
    async ({ uuid }) => {
      await (await getClient()).deleteNote(uuid);
      return {
        content: [
          { type: "text", text: JSON.stringify({ uuid, deleted: true }) },
        ],
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
    "tags.apply",
    {
      title: "Apply Tag Changes",
      description:
        "Add and remove exact tag UUIDs on a note in one operation. Under a tag-scoped MCP token, only granted tag UUIDs may be changed and the note must retain at least one granted tag. Tag scoping is an advisory client-side filter, not cryptographic isolation.",
      inputSchema: {
        noteUuid: z.string().uuid(),
        add: z.array(z.string().uuid()).max(100).default([]),
        remove: z.array(z.string().uuid()).max(100).default([]),
      },
      outputSchema: {
        uuid: z.string(),
        tags: z.array(z.object({ uuid: z.string(), title: z.string() })),
      },
    },
    async ({ noteUuid, add, remove }) => {
      const result = await (
        await getClient()
      ).applyTags(noteUuid, {
        add,
        remove,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  for (const operation of ["add", "remove"] as const) {
    server.registerTool(
      `tags.${operation}`,
      {
        title: operation === "add" ? "Add Tag" : "Remove Tag",
        description: `${operation === "add" ? "Add" : "Remove"} one exact tag UUID ${operation === "add" ? "to" : "from"} a note. Requires writes.`,
        inputSchema: {
          noteUuid: z.string().uuid(),
          tagUuid: z.string().uuid(),
        },
        outputSchema: {
          uuid: z.string(),
          tags: z.array(z.object({ uuid: z.string(), title: z.string() })),
        },
      },
      async ({ noteUuid, tagUuid }) => {
        const result = await (
          await getClient()
        ).applyTags(noteUuid, {
          add: operation === "add" ? [tagUuid] : [],
          remove: operation === "remove" ? [tagUuid] : [],
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      },
    );
  }

  server.registerTool(
    "files.attach",
    {
      title: "Attach File",
      description:
        "Encrypt and attach a local regular file to a note. Absolute paths must stay inside STANDARD_RED_NOTES_FILE_ROOTS after symlink resolution, and size is bounded.",
      inputSchema: {
        noteUuid: z.string().uuid(),
        path: z.string().min(1).max(4096),
        name: z.string().min(1).max(255).optional(),
        mimeType: z
          .string()
          .min(3)
          .max(255)
          .default("application/octet-stream"),
      },
      outputSchema: {
        uuid: z.string(),
        noteUuid: z.string(),
        name: z.string(),
        mimeType: z.string(),
        size: z.number(),
      },
    },
    async ({ noteUuid, path, name, mimeType }) => {
      const result = await (
        await getClient()
      ).attachFile({
        noteUuid,
        path,
        name,
        mimeType,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "export.create",
    {
      title: "Create Encrypted Export",
      description:
        "Create a password-encrypted account backup at an explicitly allowed absolute path. Only encrypted exports are supported; plaintext export is intentionally not exposed.",
      inputSchema: {
        outputPath: z.string().min(1).max(4096),
        overwrite: z.boolean().default(false),
      },
      outputSchema: {
        path: z.string(),
        bytes: z.number(),
        encrypted: z.literal(true),
      },
    },
    async ({ outputPath, overwrite }) => {
      const result = await (
        await getClient()
      ).createEncryptedExport({ outputPath, overwrite });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "server.status",
    {
      title: "Server Status",
      description:
        "Probe the configured Standard Red Notes server health endpoint with a bounded timeout.",
      inputSchema: {},
      outputSchema: {
        reachable: z.boolean(),
        statusCode: z.number().optional(),
        latencyMs: z.number(),
      },
    },
    async () => {
      const started = Date.now();
      let result: {
        reachable: boolean;
        statusCode?: number;
        latencyMs: number;
      };
      try {
        const response = await fetch(
          `${serverUrl.replace(/\/$/, "")}/healthcheck`,
          { signal: AbortSignal.timeout(5_000) },
        );
        result = {
          reachable: response.ok,
          statusCode: response.status,
          latencyMs: Date.now() - started,
        };
      } catch {
        result = { reachable: false, latencyMs: Date.now() - started };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "account.status",
    {
      title: "Account Status",
      description:
        "Report signed-in state, visible item counts, write mode, and exact advisory tag-scope metadata.",
      inputSchema: {},
      outputSchema: {
        signedIn: z.boolean(),
        writes: z.boolean(),
        noteCount: z.number(),
        tagCount: z.number(),
        vaultCount: z.number(),
        tagScope: z.object({
          restricted: z.boolean(),
          enforcement: z.literal("client-side-advisory"),
          cryptographic: z.literal(false),
          tagUuids: z.array(z.string()).optional(),
        }),
      },
    },
    async () => {
      const result = (await getClient()).accountStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
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

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

interface HttpSessionState {
  sessions: Map<string, HttpSession>;
  initializations: number;
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
    throw new Error("MCP_TRANSPORT=http requires MCP_HTTP_TOKEN");
  }
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error(`invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
  }
  assertSafeHttpBinding({
    host: httpHost,
    allowRemote: httpAllowRemote,
    token: httpToken,
  });

  // One Streamable HTTP transport (and McpServer) per session. The session id is
  // generated on initialize and echoed back via the `mcp-session-id` header; the
  // client must send it on subsequent requests. State is in-memory.
  const state: HttpSessionState = {
    sessions: new Map(),
    initializations: 0,
  };

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, state).catch((error) => {
      console.error("[mcp] request handler error:", diagnosticMessage(error));
      if (error instanceof HttpInputError && !res.headersSent) {
        sendJsonError(res, error.status, error.rpcCode, error.message);
        return;
      }
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
  httpServer.headersTimeout = httpBodyTimeoutMs;
  httpServer.requestTimeout = httpBodyTimeoutMs;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 100;
  httpServer.maxConnections = httpMaxSessions * 2 + 16;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  console.error(
    `[mcp] Streamable HTTP transport listening on ${httpHost}:${httpPort} (POST/GET/DELETE /mcp, bearer-authenticated)`,
  );

  const sweepInterval = setInterval(
    () => {
      const cutoff = Date.now() - httpSessionIdleMs;
      for (const [id, session] of state.sessions) {
        if (session.lastSeenAt < cutoff) {
          state.sessions.delete(id);
          void session.transport.close().catch(() => {});
        }
      }
    },
    Math.min(httpSessionIdleMs, 30_000),
  );
  sweepInterval.unref?.();

  // Close active sessions on shutdown so in-flight streams end cleanly.
  httpShutdownHook = async () => {
    clearInterval(sweepInterval);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const session of state.sessions.values()) {
      try {
        await session.transport.close();
      } catch {
        /* best-effort */
      }
    }
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: HttpSessionState,
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
  if (!isBearerAuthorized(req.headers.authorization, httpToken)) {
    sendJsonError(
      res,
      401,
      -32001,
      "Unauthorized: missing or invalid bearer token",
    );
    return;
  }

  const parsedBody =
    req.method === "POST"
      ? await readBoundedJsonBody(req, {
          maxBytes: httpMaxBodyBytes,
          timeoutMs: httpBodyTimeoutMs,
        })
      : undefined;
  const sessionId = req.headers["mcp-session-id"];
  const existing =
    typeof sessionId === "string" ? state.sessions.get(sessionId) : undefined;

  if (existing) {
    existing.lastSeenAt = Date.now();
    try {
      const handling = existing.transport.handleRequest(req, res, parsedBody);
      await (req.method === "GET"
        ? handling
        : withHttpRequestTimeout(handling, httpRequestTimeoutMs));
    } catch (error) {
      if (error instanceof HttpInputError && error.status === 504) {
        if (typeof sessionId === "string") {
          state.sessions.delete(sessionId);
        }
        await existing.transport.close().catch(() => {});
      }
      throw error;
    }
    return;
  }

  if (typeof sessionId === "string") {
    sendJsonError(res, 404, -32001, "Unknown or expired MCP session");
    return;
  }

  // No existing session. Only an `initialize` POST may open one; other methods
  // without a valid session fail closed before allocating protocol state.
  if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
    sendJsonError(res, 400, -32000, "Bad Request: no valid session id");
    return;
  }
  if (state.sessions.size + state.initializations >= httpMaxSessions) {
    sendJsonError(res, 503, -32000, "MCP session limit reached");
    return;
  }

  state.initializations += 1;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      state.sessions.set(id, { transport, lastSeenAt: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) state.sessions.delete(transport.sessionId);
  };

  try {
    const server = buildServer();
    await server.connect(transport);
    await withHttpRequestTimeout(
      transport.handleRequest(req, res, parsedBody),
      httpRequestTimeoutMs,
    );
  } finally {
    state.initializations -= 1;
    if (!transport.sessionId) {
      await transport.close().catch(() => {});
    }
  }
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

void start().catch((error) => {
  console.error("[mcp] FATAL:", diagnosticMessage(error));
  process.exitCode = 1;
});
