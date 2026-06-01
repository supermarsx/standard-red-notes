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
  ["standard_red_notes_status", "read"],
];

function scopeFor(toolName: string): Scope {
  for (const [prefix, scope] of SCOPE_BY_PREFIX) {
    if (toolName.startsWith(prefix)) return scope;
  }
  return "admin";
}

export interface SessionOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
  private catalog: CatalogEntry[] = [];

  constructor(private readonly opts: SessionOptions) {}

  async start(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
    });
    this.client = new Client(
      { name: "openclaw", version: "0.1.0" },
      { capabilities: {} },
    );
    await this.client.connect(transport);
    await this.refreshCatalog();
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
    await this.client?.close();
  }
}
