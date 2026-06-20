import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Local session/config storage for srn-client.
 *
 * Layout (under ~/.srn, overridable via $SRN_HOME):
 *   ~/.srn/config.json          active profile pointer + per-profile metadata
 *   ~/.srn/data/<profileId>/    snjs NodeDevice files (encrypted keychain + db)
 *
 * SECURITY: the snjs keychain (root key material) lives in data/<id>/keychain.json.
 * We create ~/.srn with mode 0700 and write config.json with mode 0600 so other
 * local users cannot read the session. The shared-server-key, if configured, is
 * stored here too (it is operator obfuscation config, not E2E security). On
 * Windows the POSIX modes are advisory; we set them best-effort.
 */

export interface Profile {
  serverUrl: string
  email: string
  /** Opaque id used as the snjs identifier + data dir name. */
  profileId: string
  /** Optional shared-server-key gate header value (operator obfuscation config). */
  serverKey?: string
}

export interface SrnConfig {
  activeProfile?: string
  profiles: Record<string, Profile>
}

export function srnHome(): string {
  return process.env.SRN_HOME ?? path.join(os.homedir(), '.srn')
}

function configPath(): string {
  return path.join(srnHome(), 'config.json')
}

export function dataDirFor(profileId: string): string {
  return path.join(srnHome(), 'data', profileId)
}

/** Deterministic profile id from server URL + email, so re-login reuses the keychain. */
export function profileIdFor(serverUrl: string, email: string): string {
  const h = crypto.createHash('sha256').update(`${serverUrl}\n${email.toLowerCase()}`).digest('hex')
  return h.slice(0, 16)
}

async function ensureHome(): Promise<void> {
  const home = srnHome()
  await fs.mkdir(home, { recursive: true })
  await fs.chmod(home, 0o700).catch(() => {})
}

export async function loadConfig(): Promise<SrnConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as SrnConfig
    return { ...parsed, profiles: parsed.profiles ?? {} }
  } catch {
    return { profiles: {} }
  }
}

export async function saveConfig(config: SrnConfig): Promise<void> {
  await ensureHome()
  const p = configPath()
  await fs.writeFile(p, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(p, 0o600).catch(() => {})
}

export async function setActiveProfile(profile: Profile): Promise<void> {
  const config = await loadConfig()
  config.profiles[profile.profileId] = profile
  config.activeProfile = profile.profileId
  await saveConfig(config)
  // Ensure the data dir exists with restrictive perms before snjs writes keys.
  const dir = dataDirFor(profile.profileId)
  await fs.mkdir(dir, { recursive: true })
  await fs.chmod(dir, 0o700).catch(() => {})
}

export async function getActiveProfile(): Promise<Profile | undefined> {
  const config = await loadConfig()
  if (!config.activeProfile) {
    return undefined
  }
  return config.profiles[config.activeProfile]
}

export async function clearActiveProfile(): Promise<void> {
  const config = await loadConfig()
  const active = config.activeProfile
  if (active) {
    delete config.profiles[active]
    config.activeProfile = undefined
    await saveConfig(config)
    await fs.rm(dataDirFor(active), { recursive: true, force: true }).catch(() => {})
  }
}
