/**
 * .env parsing and required-secret validation for the `config` command.
 *
 * SECURITY: nothing in this module ever returns or embeds a secret VALUE. The
 * verdicts carry only a status and, for a well-formed secret, its length —
 * `config` output must stay safe to paste into a bug report.
 */

/**
 * Minimal .env parser. Intentionally tiny: KEY=VALUE per line, ignores blanks
 * and `#` comments, strips surrounding quotes. Not a full dotenv implementation.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) {
      continue
    }
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// Required secrets the stack will not start without. We validate presence and,
// for the hex-key ones, the 64-char hex shape — WITHOUT ever printing the value.
export const REQUIRED_KEYS = [
  'AUTH_JWT_SECRET',
  'AUTH_SERVER_ENCRYPTION_SERVER_KEY',
  'VALET_TOKEN_SECRET',
  'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
  'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
  'MYSQL_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
]

export const HEX_KEYS = new Set([
  'AUTH_JWT_SECRET',
  'AUTH_SERVER_ENCRYPTION_SERVER_KEY',
  'VALET_TOKEN_SECRET',
  'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
  'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
])

export const PLACEHOLDER = /change-?me/i

export type SecretVerdict =
  { status: 'missing' } | { status: 'placeholder' } | { status: 'weak' } | { status: 'ok'; length: number }

/**
 * Classify one required secret. Order matters: an unset value is `missing`, a
 * CHANGE-ME placeholder is reported as such even if it happens to be 64 chars,
 * and only then is the hex shape enforced for the key-material entries.
 */
export function checkRequiredSecret(key: string, value: string | undefined): SecretVerdict {
  if (!value) {
    return { status: 'missing' }
  }
  if (PLACEHOLDER.test(value)) {
    return { status: 'placeholder' }
  }
  if (HEX_KEYS.has(key) && !/^[0-9a-fA-F]{64}$/.test(value)) {
    return { status: 'weak' }
  }
  return { status: 'ok', length: value.length }
}

/** Process env wins over the .env file (that is what docker compose does too). */
export function resolveEnvValue(
  key: string,
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): string | undefined {
  return processEnv[key] ?? fileEnv[key]
}

/** Whether the X-Shared-Server-Key gate is on, and in which mode. Never returns the key. */
export function sharedKeyGate(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): { enabled: boolean; mode: string } {
  const key = resolveEnvValue('SHARED_SERVER_ACCESS_KEY', processEnv, fileEnv)
  const mode = resolveEnvValue('SHARED_SERVER_ACCESS_KEY_MODE', processEnv, fileEnv)
  return { enabled: Boolean(key && key.length > 0), mode: mode || 'all' }
}
