import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Scope } from "../config/schema.js";
import { log } from "../util/log.js";
import { redactForAudit } from "../util/redact.js";

export interface CatalogEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  scope: Scope;
}

const SCOPE_BY_PREFIX: Array<[string, Scope]> = [
  ["notes.create", "write"],
  ["notes.update", "write"],
  ["notes.delete", "write"],
  ["notes.", "read"],
  ["tags.apply", "write"],
  ["tags.", "read"],
  ["files.", "files"],
  ["export.", "export"],
  ["server.", "read"],
  ["users.", "admin"],
  ["capabilities.", "admin"],
  ["sync.", "admin"],
  ["revisions.", "admin"],
];

const SCOPE_BY_NAME = new Map<string, Scope>([
  ["standard_red_notes_status", "read"],
  ["vaults.create", "write"],
  ["vaults.list", "read"],
]);

export function scopeFor(toolName: string): Scope {
  const exactScope = SCOPE_BY_NAME.get(toolName);
  if (exactScope) return exactScope;
  for (const [prefix, scope] of SCOPE_BY_PREFIX) {
    if (toolName.startsWith(prefix)) return scope;
  }
  return "admin";
}

export interface SessionOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Receives stderr from the spawned MCP process for diagnostics. */
  onStderr?: (chunk: string) => void;
  /** Scopes the caller is allowed to invoke. */
  allowedScopes: Scope[];
  /** Auditor sink. Called once per tool invocation. */
  audit: (entry: AuditEntry) => void;
}

export interface AuditEntry {
  ts: string;
  tool: string;
  scope: Scope;
  ok: boolean;
  durationMs: number;
  argsRedacted: unknown;
  resultRedacted?: unknown;
  error?: string;
}

export class McpSession {
  private client?: Client;
  private transport?: StdioClientTransport;
  private catalog: CatalogEntry[] = [];

  constructor(private readonly opts: SessionOptions) {}

  async start(): Promise<void> {
    if (this.client || this.transport) {
      throw new Error("session already started");
    }
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
      stderr: this.opts.onStderr ? "pipe" : "inherit",
    });
    this.transport = transport;
    if (this.opts.onStderr) {
      transport.stderr?.on("data", (chunk) => {
        this.opts.onStderr?.(String(chunk));
      });
    }
    const client = new Client(
      { name: "openclaw", version: "0.1.0" },
      { capabilities: {} },
    );
    this.client = client;
    try {
      await client.connect(transport);
      await this.refreshCatalog();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async refreshCatalog(): Promise<void> {
    if (!this.client) throw new Error("session not started");
    const res = await this.client.listTools();
    this.catalog = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      scope: scopeFor(t.name),
    }));
    log.info("mcp catalog", { count: this.catalog.length });
  }

  tools(): CatalogEntry[] {
    return this.catalog.filter((t) =>
      this.opts.allowedScopes.includes(t.scope),
    );
  }

  /** PID of the spawned MCP process, available while the session is running. */
  childPid(): number | null {
    return this.transport?.pid ?? null;
  }

  async call(name: string, args: unknown): Promise<unknown> {
    if (!this.client) throw new Error("session not started");
    const entry = this.catalog.find((t) => t.name === name);
    if (!entry) throw new Error(`tool not in catalog: ${name}`);
    if (!this.opts.allowedScopes.includes(entry.scope)) {
      throw new Error(
        `tool ${name} requires scope ${entry.scope} which is not granted`,
      );
    }
    const started = Date.now();
    try {
      const res = await this.client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      });
      const durationMs = Date.now() - started;
      this.opts.audit({
        ts: new Date().toISOString(),
        tool: name,
        scope: entry.scope,
        ok: !res.isError,
        durationMs,
        argsRedacted: redactForAudit(args),
        resultRedacted: redactForAudit(res.content),
      });
      return res;
    } catch (err) {
      const durationMs = Date.now() - started;
      this.opts.audit({
        ts: new Date().toISOString(),
        tool: name,
        scope: entry.scope,
        ok: false,
        durationMs,
        argsRedacted: redactForAudit(args),
        error: String(err),
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.catalog = [];
    try {
      await client?.close();
    } finally {
      await transport?.close();
    }
  }
}
