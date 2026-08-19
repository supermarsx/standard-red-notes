import type { AxiosInstance } from 'axios'

import { createSyncFilesTokenDecoder, type SyncFilesAdapter } from '@standard-red-notes/websocket-gateway'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import type { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'
import { HttpFilesServiceStorage } from './HttpFilesServiceStorage'
import { MultiContainerSyncFilesAdapter } from './MultiContainerSyncFilesAdapter'
import {
  ValetTokenFileResourceAuthorizer,
  type FileAuthorizationCrossServiceToken,
  type PersonalValetTokenClaims,
  type SharedVaultValetTokenClaims,
} from './ValetTokenFileResourceAuthorizer'

/**
 * Raw environment this composition reads. Passed in rather than read from
 * `process.env` so the decision is testable without a bootstrap.
 */
export type MultiContainerFilesEnvironment = {
  websocketSyncFilesUrl?: string
  filesServerProbeUrl?: string
  filesServerUrl?: string
  publicFilesServerUrl?: string
  authJwtSecret?: string
  valetTokenSecret?: string
}

export type MultiContainerFilesDependencies = {
  serviceProxy: ServiceProxyInterface
  endpointResolver: EndpointResolverInterface
  httpClient: Pick<AxiosInstance, 'request'>
  requestTimeoutMs?: number
}

export type InternalFilesUrlSource = 'WEBSOCKET_SYNC_FILES_URL' | 'FILES_SERVER_PROBE_URL' | 'FILES_SERVER_URL'

export type MultiContainerFilesComposition =
  | {
      advertised: true
      /** Spread straight into `SyncGatewayOptions`. */
      option: { files: SyncFilesAdapter }
      filesServerUrl: string
      source: InternalFilesUrlSource
    }
  | {
      advertised: false
      option: { filesUnsupported: true }
      reason: string
    }

const MISSING_URL_REASON =
  'no INTERNAL files service URL is configured. Set WEBSOCKET_SYNC_FILES_URL (or FILES_SERVER_PROBE_URL) to the ' +
  'address the api-gateway can reach the files service on, e.g. http://files:3000 in compose or ' +
  'http://localhost:3104 in the bundled multi-service image'

const MISSING_VALET_SECRET_REASON =
  'VALET_TOKEN_SECRET is not set, so minted valet credentials cannot be verified before they are presented to storage'

const MISSING_AUTH_SECRET_REASON =
  'AUTH_JWT_SECRET is not set, so the live session behind a file transfer cannot be re-validated'

/**
 * Resolves the INTERNAL files service base URL.
 *
 * `FILES_SERVER_URL` means two different things depending on how this fork is
 * deployed, which is the one mistake here that would look green and behave
 * badly:
 *
 *  - in the bundled multi-service image, `docker-entrypoint.sh` aliases it to
 *    `PUBLIC_FILES_SERVER_URL` — the app front door's `/files` prefix, which is
 *    not reachable from inside the container. `Container.ts` already refuses to
 *    use it as a probe target for exactly this reason.
 *  - in true multi-container compose it is the internal address
 *    (`api-gateway/.env.sample` ships `http://files:3000`).
 *
 * So it is accepted only when it is demonstrably NOT the public URL. Anything
 * ambiguous resolves to undefined and the lane is waived rather than guessed at.
 */
export function resolveInternalFilesServerUrl(
  environment: MultiContainerFilesEnvironment,
): { url: string; source: InternalFilesUrlSource } | undefined {
  const explicit = normalizeUrl(environment.websocketSyncFilesUrl)
  if (explicit) {
    return { url: explicit, source: 'WEBSOCKET_SYNC_FILES_URL' }
  }
  const probe = normalizeUrl(environment.filesServerProbeUrl)
  if (probe) {
    return { url: probe, source: 'FILES_SERVER_PROBE_URL' }
  }
  const configured = normalizeUrl(environment.filesServerUrl)
  const publicUrl = normalizeUrl(environment.publicFilesServerUrl)
  if (configured && configured !== publicUrl) {
    return { url: configured, source: 'FILES_SERVER_URL' }
  }
  return undefined
}

/**
 * Decides whether this deployment can serve FILES_V1, and builds the adapter
 * when it can.
 *
 * Fails closed: any missing or ambiguous input yields the explicit
 * `filesUnsupported` waiver plus a reason for the boot log, never a
 * half-configured adapter that advertises the capability and then fails every
 * transfer.
 */
export function createMultiContainerFilesComposition(
  environment: MultiContainerFilesEnvironment,
  dependencies: MultiContainerFilesDependencies,
): MultiContainerFilesComposition {
  const resolved = resolveInternalFilesServerUrl(environment)
  if (!resolved) {
    return waive(MISSING_URL_REASON)
  }
  const authJwtSecret = environment.authJwtSecret ?? ''
  if (!authJwtSecret) {
    return waive(MISSING_AUTH_SECRET_REASON)
  }
  const valetTokenSecret = environment.valetTokenSecret ?? ''
  if (!valetTokenSecret) {
    return waive(MISSING_VALET_SECRET_REASON)
  }

  try {
    const files = new MultiContainerSyncFilesAdapter({
      authorizer: new ValetTokenFileResourceAuthorizer({
        serviceProxy: dependencies.serviceProxy,
        endpointResolver: dependencies.endpointResolver,
        authTokenDecoder: createSyncFilesTokenDecoder<FileAuthorizationCrossServiceToken>(authJwtSecret),
        valetTokenDecoder: createSyncFilesTokenDecoder<PersonalValetTokenClaims | SharedVaultValetTokenClaims>(
          valetTokenSecret,
        ),
      }),
      storage: new HttpFilesServiceStorage({
        filesServerUrl: resolved.url,
        httpClient: dependencies.httpClient,
        ...(dependencies.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: dependencies.requestTimeoutMs }),
      }),
    })
    return { advertised: true, option: { files }, filesServerUrl: resolved.url, source: resolved.source }
  } catch (error) {
    return waive(`the files transport could not be constructed (${(error as Error).message})`)
  }
}

function waive(reason: string): MultiContainerFilesComposition {
  return { advertised: false, option: { filesUnsupported: true }, reason }
}

function normalizeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined
  }
  return trimmed.replace(/\/+$/u, '')
}
