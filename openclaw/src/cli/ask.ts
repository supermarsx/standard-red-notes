import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../config/load.js'
import { resolveProvider } from '../providers/factory.js'
import { McpSession, type AuditEntry } from '../mcp/session.js'
import { run } from '../core/agent.js'
import { log } from '../util/log.js'

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
    } catch (err) {
      log.warn('audit append failed', { err: String(err) })
    }
  }
}

export async function ask(question: string): Promise<number> {
  const cfg = loadConfig()
  const provider = resolveProvider(cfg.provider)

  if (!cfg.mcp.local) {
    process.stderr.write('No local MCP configured; ask requires at least one MCP transport.\n')
    return 1
  }

  const session = new McpSession({
    ...cfg.mcp.local,
    allowedScopes: cfg.mcp.local.scopes,
    audit: auditSink(cfg.agent.audit_file),
  })

  await session.start()

  const result = await run([{ role: 'user', content: question }], {
    provider,
    session,
    maxSteps: cfg.agent.max_steps,
    onTextDelta: (chunk) => process.stdout.write(chunk),
  })

  process.stdout.write('\n')
  await session.close()
  log.info('ask done', { steps: result.steps, stopReason: result.stopReason })
  return result.stopReason === 'error' ? 1 : 0
}
