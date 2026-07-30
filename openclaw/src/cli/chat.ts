import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/load.js";
import { resolveProvider } from "../providers/factory.js";
import { McpSession, sessionOptionsFromConfig } from "../mcp/session.js";
import { boundHistory, run } from "../core/agent.js";
import type { ChatMessage } from "../providers/types.js";
import { createAuditSink } from "../util/audit.js";
import { log } from "../util/log.js";

export async function chat(): Promise<number> {
  const cfg = loadConfig();
  const provider = resolveProvider(cfg.provider);
  if (!cfg.mcp.local && !cfg.mcp.remote) {
    process.stderr.write("No MCP configured.\n");
    return 1;
  }

  const session = new McpSession(
    sessionOptionsFromConfig(
      cfg,
      createAuditSink(cfg.agent.audit_file),
      (chunk) => log.debug("local MCP stderr", { chunk }),
    ),
  );
  await session.start();

  let rl: ReturnType<typeof createInterface> | undefined;
  const history: ChatMessage[] = [];
  const scratchpadBytes = cfg.agent.scratchpad_kb * 1024;

  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      `Open Claw — chat with ${cfg.provider.type}. Ctrl-D to exit.\n\n`,
    );
    while (true) {
      const line = await rl.question("> ");
      if (!line.trim()) continue;
      history.push({ role: "user", content: line });
      history.splice(
        0,
        history.length,
        ...boundHistory(history, scratchpadBytes),
      );

      const result = await run(history, {
        provider,
        session,
        maxSteps: cfg.agent.max_steps,
        scratchpadBytes,
        onTextDelta: (chunk) => process.stdout.write(chunk),
      });
      process.stdout.write("\n");
      history.push({ role: "assistant", content: result.finalText });
      history.splice(
        0,
        history.length,
        ...boundHistory(history, scratchpadBytes),
      );
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_USE_AFTER_CLOSE") {
      process.stderr.write(`chat ended: ${String(err)}\n`);
    }
  } finally {
    rl?.close();
    await session.close();
  }
  return 0;
}
