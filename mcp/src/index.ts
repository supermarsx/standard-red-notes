#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ServerClient } from "./serverClient.js";

const server = new McpServer(
  {
    name: "standard-red-notes",
    version: "0.2.0",
  },
  {
    instructions:
      "Standard Red Notes MCP bridge. Exposes status plus a read-only notes API surface against the configured Standard Red Notes server. Write tools require STANDARD_RED_NOTES_ALLOW_WRITES=1 in the environment.",
  },
);

const client = new ServerClient({
  baseUrl: process.env.STANDARD_RED_NOTES_SERVER_URL ?? "http://localhost:3000",
  authToken: process.env.STANDARD_RED_NOTES_AUTH_TOKEN,
  allowWrites: process.env.STANDARD_RED_NOTES_ALLOW_WRITES === "1",
});

server.registerTool(
  "standard_red_notes_status",
  {
    title: "Standard Red Notes Status",
    description: "Report MCP bridge status and the configured server URL.",
    inputSchema: {
      includeRoadmap: z
        .boolean()
        .optional()
        .describe("Include the next implementation slices."),
    },
    outputSchema: {
      status: z.string(),
      transport: z.string(),
      serverUrl: z.string(),
      writes: z.boolean(),
      next: z.array(z.string()).optional(),
    },
  },
  async ({ includeRoadmap }) => {
    const structuredContent = {
      status: "ready",
      transport: "stdio",
      serverUrl: client.baseUrl,
      writes: client.allowWrites,
      next: includeRoadmap
        ? [
            "Wire local-client adapter so note search runs against the unlocked app",
            "Add Streamable HTTP transport once auth + DNS rebinding protection ship",
            "Add server-side status/admin tools behind scoped service tokens",
          ]
        : undefined,
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
      "List recent notes from the configured Standard Red Notes server. Returns note UUIDs, titles, and updated_at. Bodies are not included.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .default(50)
        .describe("Maximum number of notes to return."),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor returned by a previous call."),
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
    const result = await client.listNotes(limit, cursor);
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
      "Search notes by title or body keywords. Returns matching note UUIDs, titles, and a snippet.",
    inputSchema: {
      query: z.string().min(1).describe("Search query."),
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
    const result = await client.searchNotes(query, limit);
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
      "Fetch a single note by UUID. Returns title, body, tags, and timestamps.",
    inputSchema: {
      uuid: z.string().uuid().describe("Note UUID."),
    },
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
    const note = await client.readNote(uuid);
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
      "Create a new note. Disabled unless STANDARD_RED_NOTES_ALLOW_WRITES=1 to keep the bootstrap bridge read-only by default.",
    inputSchema: {
      title: z.string().min(1),
      body: z.string().default(""),
      tags: z.array(z.string()).default([]),
    },
    outputSchema: {
      uuid: z.string(),
      title: z.string(),
    },
  },
  async ({ title, body, tags }) => {
    if (!client.allowWrites) {
      throw new Error(
        "Writes are disabled. Set STANDARD_RED_NOTES_ALLOW_WRITES=1 to enable notes.create.",
      );
    }
    const created = await client.createNote({ title, body, tags });
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
      "Update an existing note by UUID. Disabled unless STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: {
      uuid: z.string().uuid(),
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    outputSchema: {
      uuid: z.string(),
      updatedAt: z.string(),
    },
  },
  async ({ uuid, title, body, tags }) => {
    if (!client.allowWrites) {
      throw new Error(
        "Writes are disabled. Set STANDARD_RED_NOTES_ALLOW_WRITES=1 to enable notes.update.",
      );
    }
    const updated = await client.updateNote(uuid, { title, body, tags });
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
      "Delete a note by UUID. Disabled unless STANDARD_RED_NOTES_ALLOW_WRITES=1.",
    inputSchema: { uuid: z.string().uuid() },
    outputSchema: { uuid: z.string(), deleted: z.boolean() },
  },
  async ({ uuid }) => {
    if (!client.allowWrites) {
      throw new Error(
        "Writes are disabled. Set STANDARD_RED_NOTES_ALLOW_WRITES=1 to enable notes.delete.",
      );
    }
    await client.deleteNote(uuid);
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
    description: "List tags available on the server.",
    inputSchema: {},
    outputSchema: {
      tags: z.array(z.object({ uuid: z.string(), title: z.string() })),
    },
  },
  async () => {
    const tags = await client.listTags();
    return {
      content: [{ type: "text", text: JSON.stringify({ tags }, null, 2) }],
      structuredContent: { tags },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
