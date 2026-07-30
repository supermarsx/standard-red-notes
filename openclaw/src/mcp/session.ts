import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isLoopbackUrl, type Config, type Scope } from "../config/schema.js";
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
  ["tags.add", "write"],
  ["tags.remove", "write"],
  ["tags.", "read"],
  ["files.", "files"],
  ["export.", "export"],
  ["server.", "read"],
  ["account.", "read"],
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

type PathRule = { field: string; existing: boolean };
const FILESYSTEM_PATH_RULES = new Map<string, PathRule>([
  ["files.attach", { field: "path", existing: true }],
  ["export.create", { field: "outputPath", existing: false }],
]);

export function scopeFor(toolName: string): Scope {
  const exactScope = SCOPE_BY_NAME.get(toolName);
  if (exactScope) return exactScope;
  for (const [prefix, scope] of SCOPE_BY_PREFIX) {
    if (toolName.startsWith(prefix)) return scope;
  }
  return "admin";
}

export interface RemoteSessionOptions {
  url: string;
  bearerToken?: string;
}

export interface SessionOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  remote?: RemoteSessionOptions;
  /** Receives stderr from the spawned MCP process for diagnostics. */
  onStderr?: (chunk: string) => void;
  /** Scopes the caller is allowed to invoke. */
  allowedScopes: Scope[];
  /** Auditor sink. Called once per tool invocation. */
  audit: (entry: AuditEntry) => void;
  /** Absolute or ~-expanded roots permitted for local filesystem tools. */
  allowedFilesystemPaths?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
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

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.resolve(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function canonicalRoots(values: readonly string[]): string[] {
  return values.map((value) => {
    const expanded = expandHome(value);
    let root: string;
    try {
      root = realpathSync(expanded);
    } catch {
      throw new Error(
        "filesystem allowlist root does not exist or cannot be resolved",
      );
    }
    if (!statSync(root).isDirectory()) {
      throw new Error("filesystem allowlist root is not a directory");
    }
    return root;
  });
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function requestOptions(timeoutMs: number) {
  return { timeout: timeoutMs, maxTotalTimeout: timeoutMs };
}

export function sessionOptionsFromConfig(
  config: Config,
  audit: (entry: AuditEntry) => void,
  onStderr?: (chunk: string) => void,
): SessionOptions {
  const common = {
    audit,
    onStderr,
    allowedFilesystemPaths: config.security.allow_filesystem_paths,
  };
  if (config.mcp.local) {
    const env = { ...config.mcp.local.env };
    for (const envName of config.mcp.local.env_from) {
      const value = process.env[envName];
      if (!value) {
        throw new Error(
          `local MCP environment variable is not set: ${envName}`,
        );
      }
      env[envName] = value;
    }
    return {
      ...common,
      command: config.mcp.local.command,
      args: config.mcp.local.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      allowedScopes: config.mcp.local.scopes,
      timeoutMs: config.mcp.local.timeout_ms,
      maxResponseBytes: config.mcp.local.max_response_kb * 1024,
    };
  }
  if (config.mcp.remote) {
    const envName = config.mcp.remote.bearer_env;
    const bearerToken = envName ? process.env[envName] : undefined;
    if (envName && !bearerToken) {
      throw new Error(
        `remote MCP bearer environment variable is not set: ${envName}`,
      );
    }
    return {
      ...common,
      remote: {
        url: config.mcp.remote.url,
        ...(bearerToken ? { bearerToken } : {}),
      },
      allowedScopes: config.mcp.remote.scopes,
      timeoutMs: config.mcp.remote.timeout_ms,
      maxResponseBytes: config.mcp.remote.max_response_kb * 1024,
    };
  }
  throw new Error("no MCP transport configured");
}

export class McpSession {
  private client?: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;
  private stdioTransport?: StdioClientTransport;
  private remoteTransport?: StreamableHTTPClientTransport;
  private catalog: CatalogEntry[] = [];
  private readonly allowedRoots: string[];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly opts: SessionOptions) {
    const hasLocal = Boolean(opts.command);
    const hasRemote = Boolean(opts.remote);
    if (hasLocal === hasRemote) {
      throw new Error("configure exactly one MCP transport");
    }
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 10 * 60_000
    ) {
      throw new Error("MCP timeout must be an integer from 1000 to 600000 ms");
    }
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > 16 * 1024 * 1024
    ) {
      throw new Error(
        "MCP response limit must be an integer from 1 to 16777216 bytes",
      );
    }
    if (opts.remote) {
      const remoteUrl = new URL(opts.remote.url);
      if (!["http:", "https:"].includes(remoteUrl.protocol)) {
        throw new Error("remote MCP URL must use http or https");
      }
      if (remoteUrl.username || remoteUrl.password) {
        throw new Error("remote MCP URL must not embed credentials");
      }
      if (
        !isLoopbackUrl(remoteUrl.toString()) &&
        (remoteUrl.protocol !== "https:" || !opts.remote.bearerToken?.trim())
      ) {
        throw new Error(
          "non-loopback remote MCP requires HTTPS and bearer authentication",
        );
      }
      this.allowedRoots = [];
    } else {
      this.allowedRoots = canonicalRoots(opts.allowedFilesystemPaths ?? []);
    }
  }

  private audit(entry: AuditEntry): void {
    try {
      this.opts.audit(entry);
    } catch (error) {
      log.warn("MCP audit sink failed", {
        error: String(redactForAudit(String(error))),
      });
    }
  }

  private buildTransport():
    StdioClientTransport | StreamableHTTPClientTransport {
    if (this.opts.remote) {
      const headers = new Headers();
      if (this.opts.remote.bearerToken) {
        headers.set("authorization", `Bearer ${this.opts.remote.bearerToken}`);
      }
      const transport = new StreamableHTTPClientTransport(
        new URL(this.opts.remote.url),
        {
          requestInit: { headers },
          reconnectionOptions: {
            initialReconnectionDelay: 250,
            maxReconnectionDelay: 2_000,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 2,
          },
        },
      );
      this.remoteTransport = transport;
      return transport;
    }
    const transport = new StdioClientTransport({
      command: this.opts.command as string,
      args: this.opts.args ?? [],
      env: this.opts.env,
      stderr: this.opts.onStderr ? "pipe" : "inherit",
    });
    this.stdioTransport = transport;
    if (this.opts.onStderr) {
      transport.stderr?.on("data", (chunk) => {
        this.opts.onStderr?.(String(chunk));
      });
    }
    return transport;
  }

  async start(): Promise<void> {
    if (this.client || this.transport) {
      throw new Error("session already started");
    }
    const transport = this.buildTransport();
    this.transport = transport;
    const client = new Client(
      { name: "openclaw", version: "0.1.0" },
      { capabilities: {} },
    );
    this.client = client;
    try {
      await client.connect(transport, requestOptions(this.timeoutMs));
      await this.refreshCatalog();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async refreshCatalog(): Promise<void> {
    if (!this.client) throw new Error("session not started");
    const res = await this.client.listTools(
      undefined,
      requestOptions(this.timeoutMs),
    );
    if (byteLength(res) > this.maxResponseBytes) {
      throw new Error("MCP tool catalog exceeds configured response limit");
    }
    this.catalog = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      scope: scopeFor(t.name),
    }));
    log.info("mcp catalog", { count: this.catalog.length });
  }

  tools(): CatalogEntry[] {
    return this.catalog.filter(
      (tool) =>
        this.opts.allowedScopes.includes(tool.scope) &&
        (!FILESYSTEM_PATH_RULES.has(tool.name) ||
          (!this.opts.remote && this.allowedRoots.length > 0)),
    );
  }

  /** PID of the spawned MCP process, available for local stdio only. */
  childPid(): number | null {
    return this.stdioTransport?.pid ?? null;
  }

  private enforceFilesystemPolicy(name: string, args: unknown): void {
    const rule = FILESYSTEM_PATH_RULES.get(name);
    if (!rule) return;
    if (this.opts.remote) {
      throw new Error(
        `filesystem tool ${name} is disabled over remote MCP transport`,
      );
    }
    if (this.allowedRoots.length === 0) {
      throw new Error(
        `filesystem tool ${name} requires security.allow_filesystem_paths`,
      );
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`filesystem tool ${name} requires object arguments`);
    }
    const value = (args as Record<string, unknown>)[rule.field];
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`${name}.${rule.field} must be an absolute path`);
    }
    let candidate: string;
    try {
      if (rule.existing) {
        candidate = realpathSync(value);
      } else if (existsSync(value)) {
        const output = lstatSync(value);
        if (output.isSymbolicLink() || !output.isFile()) {
          throw new Error("symbolic link");
        }
        candidate = realpathSync(value);
      } else {
        candidate = path.join(
          realpathSync(path.dirname(value)),
          path.basename(value),
        );
      }
    } catch {
      throw new Error(`${name}.${rule.field} could not be resolved safely`);
    }
    if (!this.allowedRoots.some((root) => isWithin(root, candidate))) {
      throw new Error(
        `${name}.${rule.field} is outside the filesystem allowlist`,
      );
    }
    if (rule.existing && !statSync(candidate).isFile()) {
      throw new Error(`${name}.${rule.field} must be a regular file`);
    }
  }

  async call(name: string, args: unknown): Promise<unknown> {
    const entry = this.catalog.find((t) => t.name === name);
    const started = Date.now();
    const scope = entry?.scope ?? scopeFor(name);
    try {
      if (!this.client) throw new Error("session not started");
      if (!entry) throw new Error(`tool not in catalog: ${name}`);
      if (!this.opts.allowedScopes.includes(entry.scope)) {
        throw new Error(
          `tool ${name} requires scope ${entry.scope} which is not granted`,
        );
      }
      this.enforceFilesystemPolicy(name, args);
      const res = await this.client.callTool(
        {
          name,
          arguments: args as Record<string, unknown>,
        },
        undefined,
        requestOptions(this.timeoutMs),
      );
      if (byteLength(res) > this.maxResponseBytes) {
        throw new Error("MCP tool response exceeds configured response limit");
      }
      const durationMs = Date.now() - started;
      this.audit({
        ts: new Date().toISOString(),
        tool: name,
        scope,
        ok: !res.isError,
        durationMs,
        argsRedacted: redactForAudit(args),
        resultRedacted: redactForAudit(res.content),
      });
      return res;
    } catch (err) {
      const durationMs = Date.now() - started;
      this.audit({
        ts: new Date().toISOString(),
        tool: name,
        scope,
        ok: false,
        durationMs,
        argsRedacted: redactForAudit(args),
        error: String(redactForAudit(String(err))),
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    const remoteTransport = this.remoteTransport;
    this.client = undefined;
    this.transport = undefined;
    this.stdioTransport = undefined;
    this.remoteTransport = undefined;
    this.catalog = [];
    try {
      if (remoteTransport?.sessionId) {
        await remoteTransport.terminateSession().catch((error) => {
          log.warn("remote MCP session termination failed", {
            error: String(redactForAudit(String(error))),
          });
        });
      }
      await client?.close();
    } finally {
      await transport?.close();
    }
  }
}
