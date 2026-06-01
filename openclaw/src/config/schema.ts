import { z } from "zod";

export const providerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("anthropic"),
    model: z.string().default("claude-opus-4-7"),
    base_url: z.string().url().optional(),
  }),
  z.object({
    type: z.literal("openai"),
    model: z.string().default("gpt-4o-mini"),
    base_url: z.string().url().optional(),
  }),
  z.object({
    type: z.literal("ollama"),
    model: z.string().default("llama3.1"),
    base_url: z.string().url().default("http://127.0.0.1:11434"),
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
  args: z.array(z.string()).default(["mcp/dist/index.js"]),
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

export const configSchema = z.object({
  provider: providerSchema,
  mcp: z
    .object({
      local: mcpLocalSchema.optional(),
      remote: mcpRemoteSchema.optional(),
    })
    .default({}),
  agent: agentSchema.default({} as never),
  security: securitySchema.default({} as never),
});

export type Config = z.infer<typeof configSchema>;
