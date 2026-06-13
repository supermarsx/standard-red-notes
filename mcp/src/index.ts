#!/usr/bin/env node
import "./polyfill.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bootstrapHeadlessApp, type HeadlessApp } from "./snjs/bootstrap.js";
import { SnjsBackedClient } from "./snjs/SnjsBackedClient.js";

const serverUrl =
  process.env.STANDARD_RED_NOTES_SERVER_URL ?? "http://localhost:3000";
const allowWrites = process.env.STANDARD_RED_NOTES_ALLOW_WRITES === "1";
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
      if (!email || !password) {
        throw new Error(
          "Account not configured. Set STANDARD_RED_NOTES_EMAIL and STANDARD_RED_NOTES_PASSWORD.",
        );
      }
      headless = await bootstrapHeadlessApp({
        serverUrl,
        dataDir,
        mfaCode,
        password,
        syncIntervalMs,
      });
      if (!headless.isSignedIn()) {
        if (allowRegister) {
          await headless.register(email, password);
        } else {
          await headless.signIn(email, password, mfaCode);
        }
      } else {
        await headless.sync();
      }
      // Continuously pick up collaborators' changes (shared vaults, other
      // sessions) without waiting for the next tool call.
      headless.startSyncLoop();
      client = new SnjsBackedClient(headless, { allowWrites, baseUrl: serverUrl });
      return client;
    })();
  }
  return initPromise;
}

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
    },
  },
  async () => {
    let signedIn = false;
    try {
      if (email && password) {
        await getClient();
        signedIn = headless?.isSignedIn() ?? false;
      }
    } catch {
      signedIn = false;
    }
    const structuredContent = {
      status: "ready",
      transport: "stdio",
      serverUrl,
      writes: allowWrites,
      accountConfigured: Boolean(email && password),
      signedIn,
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

async function start(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void start();
