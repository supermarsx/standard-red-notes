import { loadConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";
import { McpSession, sessionOptionsFromConfig } from "../mcp/session.js";
import { log } from "../util/log.js";

export async function doctor(): Promise<number> {
  const out = process.stdout;
  let bad = 0;

  let cfg: Config;
  try {
    cfg = loadConfig();
    out.write("✓ config loaded\n");
  } catch (err) {
    out.write(`✗ config: ${String(err)}\n`);
    return 1;
  }

  out.write(
    `  provider: ${cfg.provider.type} (${(cfg.provider as { model?: string }).model ?? "n/a"})\n`,
  );

  if (cfg.provider.type === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    out.write("✗ ANTHROPIC_API_KEY not set\n");
    bad++;
  } else if (cfg.provider.type === "openai" && !process.env.OPENAI_API_KEY) {
    out.write("✗ OPENAI_API_KEY not set\n");
    bad++;
  } else {
    out.write("✓ provider credentials present (or not required)\n");
  }

  if (!cfg.mcp.local && !cfg.mcp.remote) {
    out.write("✗ no MCP transport configured (mcp.local or mcp.remote)\n");
    bad++;
  }

  if (cfg.mcp.local || cfg.mcp.remote) {
    const transportName = cfg.mcp.local ? "local" : "remote";
    let session: McpSession | undefined;
    try {
      session = new McpSession(sessionOptionsFromConfig(cfg, () => undefined));
      await session.start();
      const tools = session.tools();
      out.write(
        `✓ ${transportName} MCP connected, ${tools.length} tools allowed in scope\n`,
      );
      for (const t of tools) out.write(`  - ${t.name} [${t.scope}]\n`);
    } catch (err) {
      log.error(`${transportName} mcp probe failed`, { err: String(err) });
      out.write(`✗ ${transportName} MCP failed: ${String(err)}\n`);
      bad++;
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  return bad === 0 ? 0 : 1;
}
