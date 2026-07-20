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

export const mcpLocalSchema = z.object({
  command: z.string().default("node"),
  args: z.array(z.string()).default(["mcp/dist/index.cjs"]),
  env: z.record(z.string(), z.string()).optional(),
  scopes: z.array(scopeSchema).default(["read"]),
});

export const mcpRemoteSchema = z.object({
  url: z.string().url(),
  bearer_env: z.string().optional(),
  scopes: z.array(scopeSchema).default(["read"]),
});

export const agentSchema = z.object({
  max_steps: z.number().int().positive().default(8),
  scratchpad_kb: z.number().int().positive().default(64),
  audit_file: z.string().default("~/.openclaw/audit.log"),
});

export const securitySchema = z.object({
  allow_filesystem_paths: z.array(z.string()).default([]),
});

export const mcpSchema = z.object({
  local: mcpLocalSchema.optional(),
  remote: mcpRemoteSchema.optional(),
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
