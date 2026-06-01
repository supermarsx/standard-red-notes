import { createInterface } from 'node:readline/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../config/load.js'
import { resolveProvider } from '../providers/factory.js'
import { McpSession, type AuditEntry } from '../mcp/session.js'
import { run } from '../core/agent.js'
import type { ChatMessage } from '../providers/types.js'

function auditSink(file: string): (e: AuditEntry) => void {
  const expanded = file.startsWith('~') ? file.replace(/^~/, homedir()) : file
  try {
    mkdirSync(dirname(expanded), { recursive: true })
  } catch {
    // ignore
  }
  return (e) => {
    try {
      appendFileSync(expanded, JSON.stringify(e) + '\n')
    } catch {
      // ignore
    }
  }
}

export async function chat(): Promise<number> {
  const cfg = loadConfig()
  const provider = resolveProvider(cfg.provider)
  if (!cfg.mcp.local) {
    process.stderr.write('No local MCP configured.\n')
    return 1
  }

  const session = new McpSession({
    ...cfg.mcp.local,
    allowedScopes: cfg.mcp.local.scopes,
    audit: auditSink(cfg.agent.audit_file),
  })
  await session.start()

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const history: ChatMessage[] = []

  process.stdout.write(`Open Claw — chat with ${cfg.provider.type}. Ctrl-D to exit.\n\n`)

  try {
    while (true) {
      const line = await rl.question('> ')
      if (!line.trim()) continue
      history.push({ role: 'user', content: line })

      const result = await run(history, {
        provider,
        session,
        maxSteps: cfg.agent.max_steps,
        onTextDelta: (chunk) => process.stdout.write(chunk),
      })
      process.stdout.write('\n')
      history.push({ role: 'assistant', content: result.finalText })
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_USE_AFTER_CLOSE') {
      process.stderr.write(`chat ended: ${String(err)}\n`)
    }
  } finally {
    rl.close()
    await session.close()
  }
  return 0
}
