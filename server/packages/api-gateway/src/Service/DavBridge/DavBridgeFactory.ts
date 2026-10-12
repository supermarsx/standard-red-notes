import * as path from 'path'

import { SERVER_SETTINGS_BOUNDS, ServerSettingsStore, isDavBridgeModeName } from '../ServerSettings/ServerSettingsStore'
import { DavAccountStore } from './DavAccountStore'
import { DavBridgeLogger, DavBridgeService } from './DavBridgeService'
import { DavBridgeEnvBaseline, DavBridgeSettings, parseDavBridgeOriginList } from './DavBridgeSettings'
import { DavNetworkPolicy, DavNetworkPolicyOptions } from './DavNetworkPolicy'
import { DavRelay } from './DavRelay'
import { DavRelayLimiter, DavSharedCounterStore, DEFAULT_DAV_RELAY_LIMITS } from './DavRelayLimiter'
import { DavSecretCipher } from './DavSecretCipher'

/**
 * Standard Red Notes: builds the DAV bridge from the process environment.
 *
 * Kept out of the bootstrap container on purpose. How an environment variable
 * is read decides whether the feature is on and which private hosts users may
 * reach, so it is code with tests, not wiring.
 *
 * Every variable here has to exist in THREE deployers or it is silently absent
 * on one of them: `docker-compose.yml` (bare names reach the gateway through
 * the container environment), `docker-compose.single.yml` together with
 * `server/docker/single/entrypoint.sh` (which writes only the names it lists),
 * and `deploy/lxc/install.sh`.
 *
 *   DAV_BRIDGE_ENABLED                  operator switch. Default off.
 *   DAV_BRIDGE_MODE                     `relay` (the only implemented mode).
 *   DAV_BRIDGE_ALLOW_ALL_USERS          grant the per-user permission to all.
 *   DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS  comma-separated exact origins.
 *   DAV_BRIDGE_ALLOWLIST_ENV_ONLY       the admin pane may not edit that list.
 *   DAV_BRIDGE_MAX_ACCOUNTS_PER_USER    1..20, default 5.
 *   DAV_BRIDGE_DATA_PATH                where account files live.
 */

const TRUTHY = ['true', '1', 'yes', 'on']
const FALSY = ['false', '0', 'no', 'off']

/** `undefined` when unset or not recognisably a boolean: an unparseable value must not switch anything on. */
export function readDavBridgeBoolean(raw: string | undefined): boolean | undefined {
  const value = (raw ?? '').trim().toLowerCase()
  if (TRUTHY.includes(value)) {
    return true
  }
  if (FALSY.includes(value)) {
    return false
  }
  return undefined
}

export interface DavBridgeEnvReadout {
  baseline: DavBridgeEnvBaseline
  dataPath: string
  /** How many entries of the origin list were not exact origins and were dropped. */
  rejectedOrigins: number
  /** True when DAV_BRIDGE_MODE was set to something that is not even a mode name. */
  modeIgnored: boolean
}

export function readDavBridgeEnvironment(
  get: (name: string) => string | undefined,
  workingDirectory: string,
): DavBridgeEnvReadout {
  const rawMode = (get('DAV_BRIDGE_MODE') ?? '').trim().toLowerCase()
  const { origins, rejected } = parseDavBridgeOriginList(get('DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS'))
  const rawOrigins = (get('DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS') ?? '').trim()
  const rawLimit = (get('DAV_BRIDGE_MAX_ACCOUNTS_PER_USER') ?? '').trim()
  const bounds = SERVER_SETTINGS_BOUNDS.davBridgeAccountsPerUser
  const parsedLimit = /^[0-9]{1,2}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN
  const limit = parsedLimit >= bounds.minimum && parsedLimit <= bounds.maximum ? parsedLimit : undefined

  return {
    baseline: {
      enabled: readDavBridgeBoolean(get('DAV_BRIDGE_ENABLED')),
      // A mode this build does not implement is passed through, not dropped:
      // the bridge must then refuse to run, not quietly run as `relay`.
      mode: isDavBridgeModeName(rawMode) ? rawMode : undefined,
      allowAllUsers: readDavBridgeBoolean(get('DAV_BRIDGE_ALLOW_ALL_USERS')),
      allowedPrivateOrigins: rawOrigins.length > 0 ? origins : undefined,
      maxAccountsPerUser: limit,
      allowlistEnvOnly: readDavBridgeBoolean(get('DAV_BRIDGE_ALLOWLIST_ENV_ONLY')) === true,
    },
    dataPath: (get('DAV_BRIDGE_DATA_PATH') ?? '').trim() || path.resolve(workingDirectory, 'data', 'dav-bridge'),
    rejectedOrigins: rejected,
    modeIgnored: rawMode.length > 0 && !isDavBridgeModeName(rawMode),
  }
}

export interface DavBridgeFactoryOptions {
  env: (name: string) => string | undefined
  workingDirectory: string
  serverSettingsStore: ServerSettingsStore
  /** The server's existing encryption key (64 hex characters), or undefined when none is configured. */
  encryptionKey: string | undefined
  logger: DavBridgeLogger
  sharedCounterStore?: DavSharedCounterStore
  /** Test seams for the network policy (resolver, socket factory). */
  network?: DavNetworkPolicyOptions
  now?: () => number
}

export function createDavBridgeService(options: DavBridgeFactoryOptions): DavBridgeService {
  const readout = readDavBridgeEnvironment(options.env, options.workingDirectory)
  const now = options.now ?? ((): number => Date.now())
  const listeningPort = Number(options.env('PORT'))

  if (readout.rejectedOrigins > 0) {
    // The count, not the entries: what an operator mistyped may be a host name
    // they did not mean to publish in a log.
    options.logger.warn('dav bridge ignored malformed allowed origins from the environment', {
      ignored: readout.rejectedOrigins,
    })
  }
  if (readout.modeIgnored) {
    options.logger.warn('dav bridge ignored a malformed DAV_BRIDGE_MODE', { reason: 'not-a-mode-name' })
  }

  const policy = new DavNetworkPolicy({
    ...options.network,
    listeningPort: Number.isInteger(listeningPort) && listeningPort > 0 ? listeningPort : undefined,
    now,
  })

  return new DavBridgeService({
    settings: new DavBridgeSettings(options.serverSettingsStore, readout.baseline),
    store: new DavAccountStore(readout.dataPath),
    cipher: new DavSecretCipher(options.encryptionKey),
    policy,
    relay: new DavRelay(policy, now),
    limiter: new DavRelayLimiter(DEFAULT_DAV_RELAY_LIMITS, options.sharedCounterStore, now),
    logger: options.logger,
    now,
  })
}
