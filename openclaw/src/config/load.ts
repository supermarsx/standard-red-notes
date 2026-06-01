import { readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve } from 'node:path'
import * as toml from 'toml'
import { configSchema, type Config } from './schema.js'
import { log } from '../util/log.js'

const DEFAULT_PATHS = ['./openclaw.toml', '~/.openclaw/config.toml']

function expand(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}

function refuseIfWorldReadable(path: string): void {
  if (platform() === 'win32') return
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    throw new Error(
      `${path} is world- or group-readable (mode ${mode.toString(8)}). chmod 600 before continuing.`,
    )
  }
}

export function loadConfig(explicit?: string): Config {
  const candidates = explicit ? [explicit] : (process.env.OPENCLAW_CONFIG ? [process.env.OPENCLAW_CONFIG] : DEFAULT_PATHS)

  for (const candidate of candidates) {
    const path = expand(candidate)
    try {
      refuseIfWorldReadable(path)
      const text = readFileSync(path, 'utf8')
      const raw = toml.parse(text) as unknown
      const parsed = configSchema.parse(raw)
      log.info('config loaded', { path })
      return parsed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
  }

  throw new Error(
    `No config file found. Tried: ${candidates.join(', ')}. Run \`openclaw doctor --write-config\` to scaffold one.`,
  )
}
