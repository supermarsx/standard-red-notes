import { loadConfig } from "../config/load.js";
import { resolveProvider } from "../providers/factory.js";
import { McpSession, sessionOptionsFromConfig } from "../mcp/session.js";
import { run } from "../core/agent.js";
import { log } from "../util/log.js";
import { createAuditSink } from "../util/audit.js";

export async function ask(question: string): Promise<number> {
  const cfg = loadConfig();
  const provider = resolveProvider(cfg.provider);

  if (!cfg.mcp.local && !cfg.mcp.remote) {
    process.stderr.write(
      "No MCP configured; ask requires a local or remote MCP transport.\n",
    );
    return 1;
  }

  const session = new McpSession(
    sessionOptionsFromConfig(
      cfg,
      createAuditSink(cfg.agent.audit_file),
      (chunk) => log.debug("local MCP stderr", { chunk }),
    ),
  );
  try {
    await session.start();
    const result = await run([{ role: "user", content: question }], {
      provider,
      session,
      maxSteps: cfg.agent.max_steps,
      scratchpadBytes: cfg.agent.scratchpad_kb * 1024,
      onTextDelta: (chunk) => process.stdout.write(chunk),
    });
    process.stdout.write("\n");
    log.info("ask done", {
      steps: result.steps,
      stopReason: result.stopReason,
    });
    return result.stopReason === "error" ? 1 : 0;
  } finally {
    await session.close();
  }
}
