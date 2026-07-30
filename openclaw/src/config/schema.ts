import path from "node:path";
import { z } from "zod";

// `z.string().url()` delegates to `new URL()`, which reads "localhost:1234" as
// the scheme `localhost:` and accepts it. That only surfaces much later as an
// opaque fetch error, so require an absolute http(s) URL with a host here.
export const httpUrlSchema = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname.length > 0
  );
}, "must be an absolute http(s) URL, for example http://127.0.0.1:11434");

export const providerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("anthropic"),
    model: z.string().default("claude-opus-4-7"),
    base_url: httpUrlSchema.optional(),
  }),
  z.object({
    type: z.literal("openai"),
    model: z.string().default("gpt-4o-mini"),
    base_url: httpUrlSchema.optional(),
  }),
  z.object({
    type: z.literal("ollama"),
    model: z.string().default("llama3.1"),
    base_url: httpUrlSchema.default("http://127.0.0.1:11434"),
  }),
  z.object({
    type: z.literal("hermes"),
    model: z.string().default("hermes3"),
    base_url: httpUrlSchema.default("http://127.0.0.1:11434"),
    transport: z.enum(["openai", "ollama"]).default("ollama"),
    api_key_env: z.string().optional(),
  }),
  z.object({
    type: z.literal("mock"),
    script: z.array(z.string()).default([]),
  }),
]);

export type ProviderConfig = z.infer<typeof providerSchema>;

export const scopeSchema = z.enum([
  "read",
  "write",
  "files",
  "export",
  "admin",
]);
export type Scope = z.infer<typeof scopeSchema>;

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

export const mcpLocalSchema = z.object({
  command: z.string().min(1).default("node"),
  args: z.array(z.string()).default(["mcp/dist/index.cjs"]),
  env: z.record(environmentNameSchema, z.string()).optional(),
  env_from: z.array(environmentNameSchema).max(64).default([]),
  scopes: z.array(scopeSchema).default(["read"]),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60_000)
    .default(60_000),
  max_response_kb: z
    .number()
    .int()
    .positive()
    .max(16 * 1024)
    .default(1024),
});

export function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export const mcpRemoteSchema = z
  .object({
    url: httpUrlSchema,
    bearer_env: environmentNameSchema.optional(),
    scopes: z.array(scopeSchema).default(["read"]),
    allow_remote: z.boolean().default(false),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60_000)
      .default(60_000),
    max_response_kb: z
      .number()
      .int()
      .positive()
      .max(16 * 1024)
      .default(1024),
  })
  .superRefine((remote, context) => {
    const url = new URL(remote.url);
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "must not embed credentials; use bearer_env",
      });
    }
    if (!isLoopbackUrl(remote.url)) {
      if (!remote.allow_remote) {
        context.addIssue({
          code: "custom",
          path: ["allow_remote"],
          message: "must be true for a non-loopback MCP URL",
        });
      }
      if (url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["url"],
          message: "non-loopback MCP requires HTTPS",
        });
      }
      if (!remote.bearer_env) {
        context.addIssue({
          code: "custom",
          path: ["bearer_env"],
          message: "is required for authenticated non-loopback MCP",
        });
      }
    }
    for (const scope of remote.scopes) {
      if (scope === "files" || scope === "export") {
        context.addIssue({
          code: "custom",
          path: ["scopes"],
          message: `${scope} scope is local-only and cannot be granted to remote MCP`,
        });
      }
    }
  });

export const agentSchema = z.object({
  max_steps: z.number().int().positive().max(64).default(8),
  scratchpad_kb: z.number().int().min(4).max(1024).default(64),
  audit_file: z.string().min(1).max(4096).default("~/.openclaw/audit.log"),
});

const filesystemPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      value === "~" ||
      value.startsWith("~/") ||
      value.startsWith("~\\"),
    "must be absolute or start with ~",
  );

export const securitySchema = z.object({
  allow_filesystem_paths: z.array(filesystemPathSchema).max(128).default([]),
});

export const mcpSchema = z
  .object({
    local: mcpLocalSchema.optional(),
    remote: mcpRemoteSchema.optional(),
  })
  .superRefine((mcp, context) => {
    if (mcp.local && mcp.remote) {
      context.addIssue({
        code: "custom",
        message: "configure exactly one MCP transport: local or remote",
      });
    }
  });

// `.default(literal)` hands the literal back unparsed, so an omitted section
// would yield `{}` with every field undefined instead of the defaults declared
// above. Build the default by parsing, so the schema's own defaults apply.
export const configSchema = z.object({
  provider: providerSchema,
  mcp: mcpSchema.default(() => mcpSchema.parse({})),
  agent: agentSchema.default(() => agentSchema.parse({})),
  security: securitySchema.default(() => securitySchema.parse({})),
});

export type Config = z.infer<typeof configSchema>;
