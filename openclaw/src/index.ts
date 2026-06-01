#!/usr/bin/env node

import { doctor } from './cli/doctor.js'
import { ask } from './cli/ask.js'
import { chat } from './cli/chat.js'

function usage(): void {
  process.stdout.write(`Open Claw — Standard Red Notes personal assistant

Usage:
  openclaw doctor                Run config + MCP probe
  openclaw ask "question"        One-shot question, prints answer to stdout
  openclaw chat                  Interactive REPL

Env:
  OPENCLAW_CONFIG                Path to config TOML (default ~/.openclaw/config.toml)
  OPENCLAW_LOG_LEVEL             debug | info | warn | error
  ANTHROPIC_API_KEY              Anthropic key (when provider=anthropic)
  OPENAI_API_KEY                 OpenAI key (when provider=openai)
`)
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case 'doctor':
      return doctor()
    case 'ask':
      if (!rest[0]) {
        process.stderr.write('ask requires a question\n')
        return 1
      }
      return ask(rest.join(' '))
    case 'chat':
      return chat()
    case undefined:
    case '-h':
    case '--help':
      usage()
      return 0
    default:
      process.stderr.write(`unknown command: ${cmd}\n`)
      usage()
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${String(err)}\n`)
    process.exit(1)
  })
