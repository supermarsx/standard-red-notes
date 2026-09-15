/**
 * Standard Red Notes: what to actually DO about each diagnostic finding.
 *
 * *** READ THIS BEFORE ADDING A REMEDY ***
 *
 * The value of this panel is that an operator can trust it. A remedy that is
 * confidently wrong is worse than no remedy at all: it costs a restart, and it
 * moves the operator's suspicion to the wrong subsystem, which is exactly the
 * multi-day loop this panel was built to end.
 *
 * The motivating case. The boot gate reports `SYNCING_SERVER_GRPC_UNBOUND` with
 * the advice "configure SYNCING_SERVER_GRPC_URL". On the deployment that
 * prompted this work, that advice was WRONG in two different ways at once:
 *
 *   1. The bundled image's entrypoint ALREADY exports
 *      `API_GATEWAY_SYNCING_SERVER_GRPC_URL` (docker-entrypoint.sh:555) and
 *      strips it into the gateway's dotenv on every start. The variable was set.
 *   2. The gateway reads it only inside `if (SERVICE_PROXY_TYPE === 'grpc')`
 *      (api-gateway Container.ts:1048), and nothing in the repo sets
 *      `SERVICE_PROXY_TYPE`. So the URL was set AND ignored, and setting it
 *      again would have changed nothing.
 *
 * And in `MODE=home-server` the same condition cannot be satisfied by ANY
 * environment variable, because the gRPC construction block is the `else` branch
 * of the home-server check — the durable backend is called in-process instead.
 *
 * So: every remedy here is conditional on the observed topology, and when the
 * topology has not been observed (`recorded: false`, or an older server build
 * that sends no `deployment` block) the panel falls back to the server's own
 * generic copy and SAYS that it is generic. `basis` carries that distinction to
 * the UI so the operator can see which advice was derived from their deployment
 * and which is a default.
 *
 * SECURITY: this module receives booleans and closed enums only. It must never
 * be given, and never print, a configured value.
 */

import { sanitizeServerCopy } from './syncDiagnostics'

/** The topology block from GET /v1/admin/sync-diagnostics. Presence and enums only. */
export type DeploymentTopology = {
  recorded?: boolean
  mode?: 'home-server' | 'self-hosted' | 'unset' | 'other'
  serviceProxySetting?: 'grpc' | 'unset' | 'other'
  boundServiceProxy?: 'direct-call' | 'grpc' | 'http'
  cacheSetting?: 'memory' | 'redis' | 'unset' | 'other'
  syncSwitchSetting?: 'true' | 'false' | 'unset' | 'other'
  grpcSyncingProxyBound?: boolean
  grpcProxyBindableInThisMode?: boolean
  redisBound?: boolean
  presence?: Record<string, boolean>
}

/**
 * How expensive the fix is. This is the field the user asked for by name: an
 * operator staring at a broken deployment needs to know whether they are one
 * environment variable and a restart away, or whether nothing short of a rebuild
 * will do.
 */
export type RemedyEffort =
  | 'restart' /** Change configuration and restart the container. No image rebuild. */
  | 'rebuild' /** The image itself must be rebuilt; configuration cannot reach it. */
  | 'client-update' /** Needs a newer client build; no server change helps. */
  | 'none' /** Nothing configuration can do in this topology. */
  | 'wait' /** Transient or mid-boot; re-read rather than change anything. */

export const EFFORT_LABEL: Record<RemedyEffort, string> = {
  restart: 'Config + restart',
  rebuild: 'Rebuild required',
  'client-update': 'Client update',
  none: 'Not fixable here',
  wait: 'Transient',
}

export type Remedy = {
  /** The finding this answers — a precondition code, a refusal reason, or a panel-local key. */
  code: string
  /** One sentence: the thing to do, or the plain statement that nothing can be done. */
  summary: string
  /** Ordered, concrete actions. Empty when `effort` is `none` or `wait`. */
  steps: string[]
  effort: RemedyEffort
  /**
   * `verified` — derived from this deployment's observed topology.
   * `generic` — the server's own constant copy, printed because the topology is
   * unknown. The UI marks these differently ON PURPOSE.
   */
  basis: 'verified' | 'generic'
  /** The observed facts the remedy rests on, so the operator can check the reasoning. */
  because: string[]
}

const isRecorded = (topology: DeploymentTopology | undefined): topology is DeploymentTopology =>
  topology?.recorded === true

const present = (topology: DeploymentTopology, key: string): boolean => topology.presence?.[key] === true

const generic = (code: string, serverRemedy: string | undefined): Remedy => ({
  code: sanitizeServerCopy(code),
  // The one place server-authored prose is printed verbatim. It goes through the
  // redactor because it is the only path by which text this build did not write
  // reaches the screen and the copyable report.
  summary: sanitizeServerCopy(serverRemedy ?? 'The server reported no remedy for this condition.'),
  steps: [],
  effort: 'restart',
  basis: 'generic',
  because: [
    'This server build did not report its deployment topology, so the advice above is the generic default. It may not apply here — check it against your deployment before acting on it.',
  ],
})

/**
 * The gRPC durable-backend condition: the one whose stock advice is wrong on the
 * deployments most likely to be reading this.
 */
/**
 * What this condition COSTS, since the boot gate was split. It no longer takes
 * the socket down — the lane serves collaboration, API RPC, invite events and
 * files without it, and only SYNC_ITEMS is withheld. Saying so is not a footnote:
 * an operator told "the realtime lane is unavailable" goes looking for a dead
 * socket, finds a live one, and stops believing the panel.
 */
const GRPC_CONSEQUENCE =
  'This withholds SYNC_ITEMS only. The socket still carries collaboration, API RPC, invite events and files, and note syncing transparently falls back to HTTP.'

function grpcRemedy(topology: DeploymentTopology): Remedy {
  const code = 'SYNCING_SERVER_GRPC_UNBOUND'
  const urlSet = present(topology, 'SYNCING_SERVER_GRPC_URL')
  const authUrlSet = present(topology, 'AUTH_SERVER_GRPC_URL')
  const internalSecretSet = present(topology, 'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')

  if (topology.grpcProxyBindableInThisMode === false) {
    return {
      code,
      summary:
        'Not applicable on a single-container (home-server) deployment: the durable backend is called in-process, so there is no gRPC proxy to bind. Do not set SYNCING_SERVER_GRPC_URL — it will never be read.',
      steps: [],
      effort: 'none',
      basis: 'verified',
      because: [
        'MODE is home-server — the single container — so the gateway binds the in-process direct-call service proxy.',
        'The block that constructs a gRPC syncing proxy is the other branch of that same check, so it cannot run in this mode.',
        urlSet
          ? 'SYNCING_SERVER_GRPC_URL is already set on this deployment, and is being ignored.'
          : 'SYNCING_SERVER_GRPC_URL is not set, and setting it would change nothing.',
        'The bundled home-server boot path reports this condition as satisfied by construction, because its durable backend is in-process. Seeing it unmet means the gate was recorded by the standalone api-gateway boot file.',
        GRPC_CONSEQUENCE,
      ],
    }
  }

  if (topology.serviceProxySetting !== 'grpc') {
    // `self-hosted` is the bundled MULTI-container `server` image: its entrypoint
    // exports MODE=self-hosted, so this is what the shipped compose stack
    // reports. It is emphatically NOT the single container — that reports
    // `home-server` and is handled above, where gRPC is not applicable at all.
    // The panel used to call this branch "the bundled single-container image",
    // which sent compose operators looking for a container they do not run.
    const composeStack = topology.mode === 'self-hosted'

    return {
      code,
      summary:
        'SERVICE_PROXY_TYPE is not "grpc", so the gateway never constructs a gRPC proxy and never reads SYNCING_SERVER_GRPC_URL. Set the proxy type, not the URL. Restart only — no rebuild.',
      steps: [
        'Set SERVICE_PROXY_TYPE=grpc. This is the switch that decides whether the gRPC branch runs at all; without it every other gRPC variable is dead configuration.',
        urlSet
          ? 'Leave SYNCING_SERVER_GRPC_URL as it is — it is already set, and is currently being ignored rather than missing.'
          : 'Set SYNCING_SERVER_GRPC_URL to the address the gateway can reach the syncing server gRPC listener on.',
        authUrlSet
          ? 'AUTH_SERVER_GRPC_URL is already set. Keep it — the gRPC branch reads it with no default, so removing it would stop the gateway from starting.'
          : 'Set AUTH_SERVER_GRPC_URL as well. The gRPC branch reads it WITHOUT a default, so turning on SERVICE_PROXY_TYPE=grpc while it is unset makes the gateway fail to start.',
        internalSecretSet
          ? 'Confirm SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET is at least 32 bytes and identical on the syncing server. Shorter than 32 bytes counts as unconfigured, and the durable adapter then never reports ready — the lane stays closed even with the proxy bound.'
          : 'Set SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET, at least 32 bytes, to the same value on the gateway and the syncing server. Below 32 bytes it counts as unconfigured and the durable adapter never reports ready, which closes the lane even once the proxy is bound.',
        ...(composeStack
          ? [
              'On the bundled compose stack, set SERVICE_PROXY_TYPE=grpc in your .env. Compose forwards it to the server as API_GATEWAY_SERVICE_PROXY_TYPE, and the entrypoint already exports API_GATEWAY_SYNCING_SERVER_GRPC_URL and API_GATEWAY_AUTH_SERVER_GRPC_URL and regenerates the gateway dotenv on every start — so docker compose up -d picks this up and the image does not have to be rebuilt.',
            ]
          : []),
        'Restart the container, then re-run the checks on this page.',
      ],
      effort: 'restart',
      basis: 'verified',
      because: [
        'SERVICE_PROXY_TYPE is not set to "grpc" on this deployment.',
        `The bound service proxy is "${topology.boundServiceProxy ?? 'unknown'}".`,
        urlSet
          ? 'SYNCING_SERVER_GRPC_URL IS set — which is why the stock advice to "configure SYNCING_SERVER_GRPC_URL" would have led nowhere.'
          : 'SYNCING_SERVER_GRPC_URL is not set.',
        GRPC_CONSEQUENCE,
      ],
    }
  }

  return {
    code,
    summary:
      'SERVICE_PROXY_TYPE is "grpc" and the branch that binds the proxy should have run, but the gate did not observe a bound proxy. Do not change configuration on this alone.',
    steps: [],
    effort: 'wait',
    basis: 'verified',
    because: [
      'SERVICE_PROXY_TYPE is "grpc", so the construction block is reachable.',
      'The gate observation may predate the binding, or the container may still be starting. Refresh this page; if it persists, the gateway log records the construction failure.',
    ],
  }
}

function redisRemedy(topology: DeploymentTopology): Remedy {
  const code = 'REDIS_UNBOUND'
  const urlSet = present(topology, 'REDIS_URL')
  const hostSet = present(topology, 'REDIS_HOST')

  if (topology.mode === 'home-server') {
    return {
      code,
      summary:
        'A single container needs no Redis for realtime: it keeps that state in the one process holding the sockets. Seeing this condition here means the server predates that, or its gate recorded no plane at all. Upgrade the image, or set REDIS_HOST (and REDIS_PORT if it is not 6379) as a workaround. Restart only — no rebuild.',
      steps: [
        'Upgrade to a server build that attaches the in-process realtime plane. The realtime health row then reads "in-process", and this condition disappears.',
        hostSet
          ? 'On an older build: REDIS_HOST is set but the gate did not see it at boot — confirm the value reached the process, then restart.'
          : 'On an older build: set REDIS_HOST to the Redis this deployment should use, and REDIS_PORT if it is not 6379.',
        'Restart the container, then re-run the checks on this page.',
      ],
      effort: 'restart',
      basis: 'verified',
      because: [
        'MODE is home-server: one process holds every socket, so the ticket, lease, socket-budget and room state a fleet would share has nowhere else it needs to be. Redis is for running SEVERAL gateway replicas.',
        'Do not try to fix this with CACHE_TYPE: home-server forces CACHE_TYPE=memory for the gateway container, and that is deliberate — it is a separate cache from the shared state the realtime lane needs.',
      ],
    }
  }

  if (topology.cacheSetting === 'memory') {
    return {
      code,
      summary:
        'CACHE_TYPE is "memory", which suppresses the Redis binding entirely. REDIS_URL is not read while it is set that way. Restart only — no rebuild.',
      steps: [
        'Unset CACHE_TYPE, or set CACHE_TYPE=redis.',
        urlSet
          ? 'Leave REDIS_URL as it is — it is already set, and is currently not being read.'
          : 'Set REDIS_URL. Once CACHE_TYPE stops selecting the memory cache, this variable is read with no default, so the gateway will not start without it.',
        'Restart the container, then re-run the checks on this page.',
      ],
      effort: 'restart',
      basis: 'verified',
      because: [
        'CACHE_TYPE=memory was observed, and the Redis client is bound only when it is anything else.',
        urlSet ? 'REDIS_URL is set and unread.' : 'REDIS_URL is not set.',
        'Realtime sync needs fleet-shared ticket, lease and socket-budget state, which an in-process cache cannot provide.',
      ],
    }
  }

  return {
    code,
    summary: 'Set REDIS_URL. Restart only — no rebuild.',
    steps: [
      'Set REDIS_URL to the Redis this gateway should use. A comma-separated list selects cluster mode.',
      ...(hostSet && !urlSet
        ? [
            'REDIS_HOST is set, but in this mode the gateway binds Redis from REDIS_URL only — REDIS_HOST alone will not satisfy this condition.',
          ]
        : []),
      'Restart the container, then re-run the checks on this page.',
    ],
    effort: 'restart',
    basis: 'verified',
    because: [
      hostSet && !urlSet
        ? 'REDIS_HOST is set and REDIS_URL is not, which is the most common way to hit this condition without realising it.'
        : 'REDIS_URL was not present when the container was configured.',
      'Realtime sync needs fleet-shared ticket, lease and socket-budget state.',
    ],
  }
}

function connectionTokenRemedy(topology: DeploymentTopology): Remedy {
  return {
    code: 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
    summary: 'Set WEB_SOCKET_CONNECTION_TOKEN_SECRET to a strong random value. Restart only — no rebuild.',
    steps: [
      'Set WEB_SOCKET_CONNECTION_TOKEN_SECRET to a strong random value. The gateway refuses to sign socket tickets with an empty key.',
      'Use the SAME value on every gateway replica that shares ticket state, or a ticket minted by one will not verify on another.',
      'Restart the container, then re-run the checks on this page.',
    ],
    effort: 'restart',
    basis: 'verified',
    because: [
      present(topology, 'WEB_SOCKET_CONNECTION_TOKEN_SECRET')
        ? 'The variable is set now but was not present when the container was configured — the value arrived after boot, so a restart is what applies it.'
        : 'The variable is not set.',
    ],
  }
}

function killSwitchRemedy(topology: DeploymentTopology): Remedy {
  return {
    code: 'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
    summary: 'Realtime sync is switched off by configuration. Remove the switch. Restart only — no rebuild.',
    steps: [
      'Unset WEBSOCKET_SYNC_ENABLED, or set it to exactly "true". Only the exact string "false" disables the lane; any other value makes the gateway refuse to start, so it cannot be the cause here.',
      'Restart the container, then re-run the checks on this page.',
    ],
    effort: 'restart',
    basis: 'verified',
    because: [
      topology.syncSwitchSetting === 'false'
        ? 'WEBSOCKET_SYNC_ENABLED is set to "false". This is a deliberate kill switch, not a misconfiguration — someone turned the lane off.'
        : `WEBSOCKET_SYNC_ENABLED currently reads as "${topology.syncSwitchSetting ?? 'unknown'}", which does not match the boot-time observation. The value changed after the container started; the restart is what will apply it.`,
    ],
  }
}

/**
 * The HOST's own condition, not one of the shared four.
 *
 * Worth its own block because the failure it describes is invisible everywhere
 * else: with a malformed namespace the host refuses to attach and closes the
 * push bridge — deliberately, because attaching WITHOUT the namespace would
 * publish on the un-namespaced channels of whatever sibling stack shares that
 * Redis. Until the host reported this, the panel showed the lane enabled, the
 * gateway unattached and no condition at all, and an operator had nothing to
 * search for.
 */
function redisNamespaceRemedy(serverRemedy: string | undefined): Remedy {
  return {
    code: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
    summary:
      'WEBSOCKET_REDIS_NAMESPACE is set to a value the gateway will not use, so it attached nothing. Fix or unset it. Restart only — no rebuild.',
    steps: [
      'Set WEBSOCKET_REDIS_NAMESPACE to lowercase letters, digits, colon, underscore or hyphen, 1 to 64 characters, with no leading or trailing colon — or unset it entirely, which is the default and keeps today’s channel and key names.',
      'Unsetting it is safe on a Redis this deployment does not share. The namespace exists to keep two stacks on one Redis from reading each other’s channels; with a single stack there is nothing to separate.',
      'Use the SAME value on every process in the stack. A gateway and a home server that disagree publish and subscribe on different channels and deliver nothing to each other, with no error on either side.',
      'Restart the container, then re-run the checks on this page.',
    ],
    effort: 'restart',
    basis: 'verified',
    because: [
      'The host refused to attach rather than fall back to the un-namespaced names, because that fallback would publish this stack’s events onto a sibling stack’s channels.',
      'This is why the lane can read as configured while nothing is delivered: the gate’s four conditions were all met, and the host declined afterwards.',
      // The SERVER's own sentence for this condition, printed verbatim beside
      // the panel's. It is a frozen constant over there (SYNC_HOST_REMEDIES);
      // reproducing it here instead would let the two drift silently, and the
      // whole point of this condition is that it has no other symptom to check
      // the wording against.
      ...(serverRemedy ? [`The server states: ${sanitizeServerCopy(serverRemedy)}`] : []),
    ],
  }
}

/**
 * The remedy for one unmet boot-gate precondition.
 *
 * `serverRemedy` is the constant copy the server sent. It is used ONLY when this
 * module has nothing topology-aware to say — either because the topology was not
 * reported, or because the code is one a newer server knows about and this client
 * does not. Silently dropping an unrecognised code would turn a newer server's
 * diagnosis into a blank space.
 */
export function remedyForPrecondition(
  code: string,
  serverRemedy: string | undefined,
  topology: DeploymentTopology | undefined,
): Remedy {
  if (!isRecorded(topology)) {
    return generic(code, serverRemedy)
  }

  switch (code) {
    case 'SYNCING_SERVER_GRPC_UNBOUND':
      return grpcRemedy(topology)
    case 'REDIS_UNBOUND':
      return redisRemedy(topology)
    case 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING':
      return connectionTokenRemedy(topology)
    case 'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION':
      return killSwitchRemedy(topology)
    case 'WEBSOCKET_REDIS_NAMESPACE_INVALID':
      return redisNamespaceRemedy(serverRemedy)
    default:
      return generic(code, serverRemedy)
  }
}

/**
 * Remedies for the gateway's LIVE refusal reasons — the ones it reports when the
 * boot gate passed but it is still refusing tickets.
 */
export function remedyForLiveReason(reason: string, topology: DeploymentTopology | undefined): Remedy | undefined {
  switch (reason) {
    case 'no-allowed-origins':
      return {
        code: reason,
        summary:
          'No request origin is permitted, so the handshake is refused before it starts. Restart only — no rebuild.',
        steps: [
          'Set WEBSOCKET_SYNC_ALLOWED_ORIGINS to the exact origins clients connect from, or set PUBLIC_URL and let the same-origin entry be derived from it.',
          'An explicit list is strict: one unsafe member fails startup rather than being skipped.',
          'Restart the container, then re-run the checks on this page.',
        ],
        effort: 'restart',
        basis: isRecorded(topology) ? 'verified' : 'generic',
        because: isRecorded(topology)
          ? [
              present(topology, 'WEBSOCKET_SYNC_ALLOWED_ORIGINS')
                ? 'WEBSOCKET_SYNC_ALLOWED_ORIGINS is set, so the list is present but resolved to nothing usable.'
                : 'WEBSOCKET_SYNC_ALLOWED_ORIGINS is not set.',
              present(topology, 'PUBLIC_URL')
                ? 'PUBLIC_URL is set, so a same-origin entry should have been derived — a malformed or non-network URL yields an empty list instead of an error.'
                : 'PUBLIC_URL is not set, so nothing could be derived from it either.',
            ]
          : ['The deployment topology was not reported, so only the generic advice applies.'],
      }
    case 'ticket-store-unavailable':
    case 'command-lease-store-unavailable':
    case 'socket-budget-store-unavailable':
      return {
        code: reason,
        summary:
          'Redis is bound but not answering. This is an infrastructure fault, not a missing setting — nothing in the gateway configuration fixes it.',
        steps: [
          'Check that the Redis this gateway points at is up and reachable from the gateway container.',
          'The gateway retries on its own with a bounded backoff, so this clears without a restart once Redis answers.',
        ],
        effort: 'wait',
        basis: 'verified',
        because: ['The gate passed, so Redis is configured; the store itself is not responding.'],
      }
    /**
     * The session plane, not the durable one. On the api-gateway this adapter
     * reports unready for exactly one reason — an empty AUTH_JWT_SECRET — and
     * that single variable gates EVERY capability on the socket, because every
     * command and status revalidates the original session token before it runs.
     * Left with no remedy block, this reason printed the panel's "no guidance
     * for it" line for the one condition with the shortest fix on the screen.
     */
    case 'authorization-adapter-unavailable':
      return {
        code: reason,
        summary:
          'The session-revalidation adapter is not ready. On this gateway that means AUTH_JWT_SECRET is empty. Restart only — no rebuild.',
        steps: [
          'Set AUTH_JWT_SECRET, and set it to the SAME value the auth server uses. A session token signed by one and verified by the other must agree on the key.',
          'This is not the durable backend and not the connection-token secret: those are separate variables with separate conditions. Every socket capability rests on this one, because each command revalidates the session before it runs.',
          'Restart the container, then re-run the checks on this page.',
        ],
        effort: 'restart',
        basis: isRecorded(topology) ? 'verified' : 'generic',
        because: isRecorded(topology)
          ? [
              present(topology, 'AUTH_JWT_SECRET')
                ? 'AUTH_JWT_SECRET is set now but the adapter still reports the session plane unready — confirm the value reached this process, and that it is not whitespace.'
                : 'AUTH_JWT_SECRET is not set on this deployment.',
              'This is independent of the durable backend: an unbound gRPC proxy withholds SYNC_ITEMS only, whereas this closes the lane outright.',
            ]
          : ['The deployment topology was not reported, so only the generic advice applies.'],
      }
    /**
     * Reported, but no longer a lane precondition: the invite bus gates
     * INVITE_EVENTS per socket inside the command handler, which is why a
     * client that connected during a one-second Redis reconnect used to be
     * HTTP-only for the whole session. Saying that plainly is the remedy — the
     * wrong action here is a restart.
     */
    case 'invite-event-store-unavailable':
      return {
        code: reason,
        summary:
          'The durable invite-event store is not answering. This withholds INVITE_EVENTS only; the socket and every other capability stay up.',
        steps: [
          'Check that the Redis this gateway points at is up and reachable from the gateway container.',
          'Do not restart on this alone. It clears by itself when Redis answers, and a restart costs every live socket for a condition that no longer closes the lane.',
          'While it persists, invitations are delivered by the ordinary HTTP polling path instead of being pushed.',
        ],
        effort: 'wait',
        basis: 'verified',
        because: [
          'The gate passed, so Redis is configured; the invite store itself is not responding.',
          'This reason was removed from the lane conjunction precisely because gating the whole socket on it turned a brief reconnect into an HTTP-only session.',
        ],
      }
    case 'durable-backend-unavailable':
      return {
        code: reason,
        summary: 'The durable syncing backend is configured but not reachable. Check the backend, not the gateway.',
        steps: [
          'Check that the syncing server is up and that its gRPC listener is reachable from the gateway.',
          'If the gateway and the syncing server disagree on SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET, or either side has one shorter than 32 bytes, the backend never reports ready even while the connection succeeds.',
        ],
        effort: 'restart',
        basis: 'verified',
        because: ['The boot gate passed, so a proxy is bound; readiness is what is failing.'],
      }
    case 'gateway-stopping':
      return {
        code: reason,
        summary: 'The gateway is shutting down and is refusing new tickets. Expected during a restart.',
        steps: [],
        effort: 'wait',
        basis: 'verified',
        because: ['This clears by itself once the process finishes restarting.'],
      }
    case 'disabled-by-configuration':
      return killSwitchRemedy(topology ?? {})
    case 'sync-not-configured':
      return {
        code: reason,
        summary: 'The lane was never composed at boot. The unmet boot-gate conditions are the real finding.',
        steps: ['Work through the Boot gate section — this reason is a consequence of those, not a separate problem.'],
        effort: 'none',
        basis: 'verified',
        because: ['A live refusal on top of an unmet gate restates the gate.'],
      }
    default:
      return undefined
  }
}

/**
 * The deployment marker.
 *
 * The no-rebuild path genuinely does not exist here, and saying so is the useful
 * part. The served identity is only published when the RUNTIME value equals the
 * marker baked into the image, so stamping `SRN_DEPLOY_REVISION` on a running
 * container leaves an unstamped image exactly as unstamped as before — it just
 * moves the mismatch. The build contexts exclude `.git`, so the revision cannot
 * be derived during the build and must be passed in.
 */
export function remedyForUnstampedDeployment(): Remedy {
  return {
    code: 'DEPLOYMENT_UNSTAMPED',
    summary:
      'The running image was built without a revision. This one genuinely cannot be fixed without rebuilding — setting the variable on the running container will not help.',
    steps: [
      'Rebuild with the revision passed in: --build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD). It must be exactly 40 lowercase hexadecimal characters, and the build will fail loudly if it is not.',
      'The build context excludes .git on purpose, so the build cannot work the revision out for itself — it has to be supplied.',
      'Setting SRN_DEPLOY_REVISION on the running container does NOT stamp it: the identity is only published when the runtime value matches the marker baked into the image, so on an unstamped image it stays unpublished.',
    ],
    effort: 'rebuild',
    basis: 'verified',
    because: [
      'The marker reports the explicit "unstamped" sentinel, which is what a build with no revision argument records.',
    ],
  }
}

/** A capability the server can negotiate and this client build cannot consume. */
export function remedyForClientGap(operations: readonly string[]): Remedy {
  return {
    code: 'CLIENT_GAP',
    summary: `No server configuration enables ${operations.join(', ')} — this client build has no handler for it.`,
    steps: ['Update the client. Nothing on the server changes this.'],
    effort: 'client-update',
    basis: 'verified',
    because: [
      'The server advertises the operation and the client does not implement it, so the two lists disagree in the direction only a client release can close.',
    ],
  }
}
