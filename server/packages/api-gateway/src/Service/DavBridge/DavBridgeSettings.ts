import {
  isDavBridgeModeName,
  isExactHttpOrigin,
  PersistedDavBridgeSettings,
  SERVER_SETTINGS_BOUNDS,
  ServerSettingsPatch,
  ServerSettingsStore,
} from '../ServerSettings/ServerSettingsStore'
import { davRefusal } from './DavBridgeRefusal'

/**
 * Standard Red Notes: the administrator's settings for the DAV bridge.
 *
 * Same precedence as every other runtime setting: the value an administrator
 * saved in the admin pane, then the environment, then the default. It is read
 * from the shared settings file on every call, so the switch works as a kill
 * switch without a restart.
 *
 * ONE DIFFERENCE from the general settings resolver, and it is deliberate. That
 * resolver treats an unreadable settings file as "nothing was saved" and falls
 * back to the environment, which is right for a log level. Here it would mean
 * that an administrator who switched the bridge OFF in the pane has it switched
 * back ON by a corrupted file whenever the environment says on, and that a
 * removed origin comes back. So an unreadable file makes the bridge refuse
 * (`dav-settings-unavailable`) instead of guessing.
 */

/** The modes this build implements. `relay`: forward requests, keep no calendar content. */
export const DAV_BRIDGE_IMPLEMENTED_MODES: readonly string[] = ['relay']
export const DAV_BRIDGE_DEFAULT_MODE = 'relay'
export const DAV_BRIDGE_DEFAULT_MAX_ACCOUNTS = 5

export type DavBridgeSettingSource = 'persisted' | 'env' | 'default'

/** What the environment says. `undefined` means the variable is unset. */
export interface DavBridgeEnvBaseline {
  enabled?: boolean
  mode?: string
  allowAllUsers?: boolean
  allowedPrivateOrigins?: string[]
  maxAccountsPerUser?: number
  /** DAV_BRIDGE_ALLOWLIST_ENV_ONLY: the pane shows the origin list and cannot change it. */
  allowlistEnvOnly: boolean
}

export interface ResolvedDavBridgeSettings {
  enabled: boolean
  mode: string
  /** False when `mode` names something this build does not implement. */
  modeImplemented: boolean
  allowAllUsers: boolean
  allowedPrivateOrigins: string[]
  maxAccountsPerUser: number
  allowlistEnvOnly: boolean
}

export interface DavBridgeSettingsView {
  settings: Omit<ResolvedDavBridgeSettings, 'modeImplemented' | 'allowlistEnvOnly'>
  sources: Record<
    'enabled' | 'mode' | 'allowAllUsers' | 'allowedPrivateOrigins' | 'maxAccountsPerUser',
    DavBridgeSettingSource
  >
  modes: string[]
  modeImplemented: boolean
  allowlistEditable: boolean
}

export type DavBridgeSettingsPatch = NonNullable<ServerSettingsPatch['davBridge']>

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

const isAccountLimit = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= SERVER_SETTINGS_BOUNDS.davBridgeAccountsPerUser.minimum &&
  value <= SERVER_SETTINGS_BOUNDS.davBridgeAccountsPerUser.maximum

/**
 * Reads the comma-separated origin list of DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS.
 * An entry that is not an exact origin is DROPPED, never repaired: trimming
 * `http://nextcloud/dav` to its origin would allow something the operator did
 * not write. The dropped entries are returned so that the boot log can name how
 * many there were (not what they were).
 */
export function parseDavBridgeOriginList(raw: string | undefined): { origins: string[]; rejected: number } {
  const origins: string[] = []
  let rejected = 0
  for (const entry of (raw ?? '').split(',')) {
    const candidate = entry.trim()
    if (candidate.length === 0) {
      continue
    }
    if (!isExactHttpOrigin(candidate)) {
      rejected += 1
      continue
    }
    if (!origins.includes(candidate) && origins.length < SERVER_SETTINGS_BOUNDS.davBridgeAllowedOrigins.maximum) {
      origins.push(candidate)
    }
  }
  return { origins, rejected }
}

export class DavBridgeSettings {
  constructor(
    private readonly store: ServerSettingsStore,
    private readonly env: DavBridgeEnvBaseline,
  ) {}

  /** The effective settings. Throws `dav-settings-unavailable` when the file cannot be read. */
  async resolve(): Promise<ResolvedDavBridgeSettings> {
    return this.resolveFrom(await this.readPersisted()).resolved
  }

  async view(): Promise<DavBridgeSettingsView> {
    const { resolved, sources } = this.resolveFrom(await this.readPersisted())
    return {
      settings: {
        enabled: resolved.enabled,
        mode: resolved.mode,
        allowAllUsers: resolved.allowAllUsers,
        allowedPrivateOrigins: resolved.allowedPrivateOrigins,
        maxAccountsPerUser: resolved.maxAccountsPerUser,
      },
      sources,
      modes: [...DAV_BRIDGE_IMPLEMENTED_MODES],
      modeImplemented: resolved.modeImplemented,
      allowlistEditable: !resolved.allowlistEnvOnly,
    }
  }

  /**
   * Saves administrator overrides. `undefined` leaves a key alone, `null`
   * clears the override. Refuses to touch the origin list when the operator
   * pinned it to the environment.
   */
  async applyPatch(patch: DavBridgeSettingsPatch): Promise<void> {
    if (patch.allowedPrivateOrigins !== undefined && this.env.allowlistEnvOnly) {
      throw davRefusal.allowlistEnvOnly()
    }
    await this.store.update({ davBridge: patch })
  }

  private async readPersisted(): Promise<PersistedDavBridgeSettings> {
    try {
      return (await this.store.read()).davBridge ?? {}
    } catch {
      throw davRefusal.settingsUnavailable()
    }
  }

  private resolveFrom(persisted: PersistedDavBridgeSettings): {
    resolved: ResolvedDavBridgeSettings
    sources: DavBridgeSettingsView['sources']
  } {
    const env = this.env
    const pick = <T>(
      persistedValue: unknown,
      envValue: T | undefined,
      fallback: T,
      isValid: (value: unknown) => value is T,
    ): { value: T; source: DavBridgeSettingSource } => {
      if (isValid(persistedValue)) {
        return { value: persistedValue, source: 'persisted' }
      }
      if (envValue !== undefined && isValid(envValue)) {
        return { value: envValue, source: 'env' }
      }
      return { value: fallback, source: 'default' }
    }
    const isOriginList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isExactHttpOrigin)

    const enabled = pick(persisted.enabled, env.enabled, false, isBoolean)
    const mode = pick(persisted.mode, env.mode, DAV_BRIDGE_DEFAULT_MODE, isDavBridgeModeName)
    const allowAllUsers = pick(persisted.allowAllUsers, env.allowAllUsers, false, isBoolean)
    // With the list pinned to the environment, a value saved earlier in the
    // pane is ignored as well as uneditable: "environment only" would be a
    // strange name for a list that an old saved value still overrides.
    const origins = pick(
      env.allowlistEnvOnly ? undefined : persisted.allowedPrivateOrigins,
      env.allowedPrivateOrigins,
      [] as string[],
      isOriginList,
    )
    const maxAccounts = pick(
      persisted.maxAccountsPerUser,
      env.maxAccountsPerUser,
      DAV_BRIDGE_DEFAULT_MAX_ACCOUNTS,
      isAccountLimit,
    )

    return {
      resolved: {
        enabled: enabled.value,
        mode: mode.value,
        modeImplemented: DAV_BRIDGE_IMPLEMENTED_MODES.includes(mode.value),
        allowAllUsers: allowAllUsers.value,
        allowedPrivateOrigins: [...origins.value],
        maxAccountsPerUser: maxAccounts.value,
        allowlistEnvOnly: env.allowlistEnvOnly,
      },
      sources: {
        enabled: enabled.source,
        mode: mode.source,
        allowAllUsers: allowAllUsers.source,
        allowedPrivateOrigins: origins.source,
        maxAccountsPerUser: maxAccounts.source,
      },
    }
  }
}
