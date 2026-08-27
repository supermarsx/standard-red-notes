import type { DeploymentTopology } from './diagnosticRemedies'
import { sanitizeServerCopy, type Tone } from './syncDiagnostics'

/**
 * Standard Red Notes: the configuration-presence view.
 *
 * The single most expensive failure this panel exists to prevent is a variable
 * that is SET AND NEVER READ. It looks correct in every compose file, in every
 * `printenv`, and in the operator's memory of having configured it — and it is
 * inert, because some other switch decides whether its branch runs at all. That
 * is precisely how `SYNCING_SERVER_GRPC_URL` sat configured on a deployment whose
 * realtime lane was off for days.
 *
 * So this view does not merely list which variables are set. It marks the ones
 * that are set and will not be read in the OBSERVED topology, and it marks the
 * ones that are unset but would be required if a switch were flipped. Both
 * judgements are made only when the topology was actually reported; without it
 * every row degrades to bare presence, with no claim about whether it matters.
 *
 * SECURITY: `present` is a boolean off the wire. No value is ever received here,
 * so none can be rendered. Variable NAMES are public — they are in the compose
 * files and the documentation — and the report is designed to be pasted into an
 * issue, so nothing beyond a name may enter a row.
 */

export type EnvironmentRelevance =
  | 'required' /** Read in this topology, and the lane needs it. */
  | 'optional' /** Read in this topology; absence is a supported configuration. */
  | 'inert' /** Present or not, this topology never reads it. */
  | 'unknown' /** Topology not reported; no claim is made. */

export type EnvironmentRow = {
  key: string
  present: boolean
  relevance: EnvironmentRelevance
  tone: Tone
  /** Why this row is interesting, or empty when it is simply ordinary. */
  note: string
}

export type EnvironmentGroup = {
  title: string
  description: string
  rows: EnvironmentRow[]
}

const GROUPS: { title: string; description: string; keys: string[] }[] = [
  {
    title: 'Realtime transport',
    description: 'What the socket handshake itself needs before a client can be let on.',
    keys: [
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
      'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
      'PUBLIC_URL',
      'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
    ],
  },
  {
    title: 'Shared state',
    description: 'Ticket, command-lease and socket-budget state. Realtime sync cannot run on an in-process cache.',
    keys: ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT'],
  },
  {
    title: 'Durable backend',
    description: 'How the gateway reaches the syncing server, and how that hop is authenticated.',
    keys: [
      'SYNCING_SERVER_GRPC_URL',
      'AUTH_SERVER_GRPC_URL',
      'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET',
      'SYNCING_SERVER_JS_URL',
    ],
  },
  {
    title: 'Files lane',
    description: 'What FILES_V1 needs in order to be advertised at all.',
    keys: [
      'WEBSOCKET_SYNC_FILES_URL',
      'FILES_SERVER_PROBE_URL',
      'FILES_SERVER_URL',
      'VALET_TOKEN_SECRET',
      'AUTH_JWT_SECRET',
    ],
  },
  {
    title: 'Event fan-out',
    description: 'Optional. Absent on single-node deployments, which fan events out in-process instead.',
    keys: ['SQS_QUEUE_URL', 'SNS_TOPIC_ARN'],
  },
  {
    title: 'Deployment identity',
    description: 'Answers "which build is live". Baked at image build time; see the Deployment section.',
    keys: ['SRN_DEPLOY_REVISION', 'SRN_DEPLOY_VERSION'],
  },
]

const OPTIONAL_KEYS = new Set([
  'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
  'PUBLIC_URL',
  'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
  'REDIS_PORT',
  'SQS_QUEUE_URL',
  'SNS_TOPIC_ARN',
  'SRN_DEPLOY_REVISION',
  'SRN_DEPLOY_VERSION',
  'SYNCING_SERVER_JS_URL',
  'FILES_SERVER_PROBE_URL',
  'FILES_SERVER_URL',
])

/**
 * The judgement calls. Each one is a statement about which branch of the gateway
 * bootstrap reads a variable, and each is drawn from the topology the server
 * reported rather than assumed.
 */
function classify(
  key: string,
  present: boolean,
  topology: DeploymentTopology,
): { relevance: EnvironmentRelevance; note: string } {
  const grpcBranchRuns = topology.serviceProxySetting === 'grpc' && topology.grpcProxyBindableInThisMode !== false
  const homeServer = topology.mode === 'home-server'

  if (key === 'SYNCING_SERVER_GRPC_URL' || key === 'AUTH_SERVER_GRPC_URL') {
    if (!grpcBranchRuns) {
      return {
        relevance: 'inert',
        note: homeServer
          ? 'Never read in home-server mode: the durable backend is called in-process, so no gRPC client is constructed.'
          : present
            ? 'Set, and NOT read: the gRPC branch runs only when SERVICE_PROXY_TYPE is exactly "grpc".'
            : 'Not read here: the gRPC branch runs only when SERVICE_PROXY_TYPE is exactly "grpc".',
      }
    }

    return {
      relevance: 'required',
      note: present ? '' : 'Read with no default once SERVICE_PROXY_TYPE=grpc — the gateway will not start without it.',
    }
  }

  if (key === 'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET') {
    if (!grpcBranchRuns) {
      return { relevance: 'inert', note: 'Only used by the gRPC durable adapter, which is not constructed here.' }
    }

    return {
      relevance: 'required',
      note: 'Must be at least 32 bytes and identical on the syncing server. Anything shorter counts as unconfigured and the durable adapter never reports ready.',
    }
  }

  if (key === 'REDIS_URL') {
    if (homeServer) {
      return {
        relevance: 'inert',
        note: 'Not used in home-server mode: the gateway container is pinned to an in-memory cache, and the realtime lane reads REDIS_HOST instead.',
      }
    }
    if (topology.cacheSetting === 'memory') {
      return {
        relevance: 'inert',
        note: present
          ? 'Set, and NOT read: CACHE_TYPE=memory suppresses the Redis binding entirely.'
          : 'Not read while CACHE_TYPE=memory suppresses the Redis binding.',
      }
    }

    return { relevance: 'required', note: present ? '' : 'This is the variable that binds Redis in this topology.' }
  }

  if (key === 'REDIS_HOST') {
    if (homeServer) {
      return {
        relevance: 'required',
        note: present ? '' : 'This is what the home-server realtime lane reads for shared state.',
      }
    }

    return {
      relevance: 'inert',
      note: present
        ? 'Set, but this topology binds Redis from REDIS_URL only — this alone does not satisfy the Redis condition.'
        : 'Not used for the gateway Redis binding in this topology; REDIS_URL is.',
    }
  }

  if (key === 'REDIS_PORT' && !homeServer) {
    return {
      relevance: 'inert',
      note: 'Paired with REDIS_HOST, which this topology does not use for the gateway binding.',
    }
  }

  if (OPTIONAL_KEYS.has(key)) {
    return { relevance: 'optional', note: '' }
  }

  return { relevance: 'required', note: '' }
}

const TONES: Record<EnvironmentRelevance, (present: boolean) => Tone> = {
  required: (present) => (present ? 'good' : 'bad'),
  optional: () => 'neutral',
  // Inert is a warning when the variable IS set, because that is the state that
  // misleads: the operator believes it is doing something. Unset and inert is
  // simply correct, and is not worth alarming anyone about.
  inert: (present) => (present ? 'warn' : 'neutral'),
  unknown: () => 'neutral',
}

export function buildEnvironmentGroups(topology: DeploymentTopology | undefined): EnvironmentGroup[] {
  const recorded = topology?.recorded === true
  const presence = topology?.presence ?? {}
  const known = new Set(GROUPS.flatMap((group) => group.keys))

  const groups = GROUPS.map((group) => ({
    title: group.title,
    description: group.description,
    rows: group.keys
      .filter((key) => key in presence)
      .map((key) => {
        const present = presence[key] === true
        const { relevance, note } = recorded
          ? classify(key, present, topology as DeploymentTopology)
          : { relevance: 'unknown' as EnvironmentRelevance, note: '' }

        return { key, present, relevance, tone: TONES[relevance](present), note }
      }),
  })).filter((group) => group.rows.length > 0)

  // A newer server reporting a key this client build has never heard of must not
  // vanish: an unknown-but-present variable is still evidence, and a silently
  // dropped row is the failure mode this whole panel was built to end.
  const extras = Object.keys(presence)
    .filter((key) => !known.has(key))
    .sort()
  if (extras.length > 0) {
    groups.push({
      title: 'Reported by a newer server',
      description: 'This server reports these; this client build has no guidance for them.',
      rows: extras.map((key) => ({
        // This is the only row whose KEY this build did not choose — it came off
        // the wire from a newer server — so it is the only one that can carry
        // something other than a variable name.
        key: sanitizeServerCopy(key),
        present: presence[key] === true,
        relevance: 'unknown' as EnvironmentRelevance,
        tone: 'neutral' as Tone,
        note: '',
      })),
    })
  }

  return groups
}

export type TopologyFact = { label: string; value: string; note: string }

/** The topology header: short, plain statements of what kind of deployment this is. */
export function describeTopology(topology: DeploymentTopology | undefined): TopologyFact[] {
  if (topology?.recorded !== true) {
    return [
      {
        label: 'Topology',
        value: 'not reported',
        note: 'This server build does not report its topology, so every remedy on this page falls back to generic advice that may not apply here.',
      },
    ]
  }

  const modeNote: Record<NonNullable<DeploymentTopology['mode']>, string> = {
    'home-server': 'Bundled single-process deployment. The durable backend is called in-process, not over gRPC.',
    'self-hosted':
      'Self-hosted deployment. The gRPC branch is reachable, but only when SERVICE_PROXY_TYPE is exactly "grpc".',
    unset: 'MODE is unset — the ordinary multi-container deployment.',
    other: 'MODE is set to something this build does not recognise. It behaves as if unset.',
  }

  return [
    { label: 'MODE', value: topology.mode ?? 'unknown', note: modeNote[topology.mode ?? 'unset'] },
    {
      label: 'SERVICE_PROXY_TYPE',
      value: topology.serviceProxySetting ?? 'unknown',
      note:
        topology.serviceProxySetting === 'grpc'
          ? 'The gRPC construction branch is selected.'
          : 'Not "grpc", so no gRPC client is constructed and every gRPC address variable is inert.',
    },
    {
      label: 'Service proxy in use',
      value: topology.boundServiceProxy ?? 'unknown',
      note: 'The branch that actually ran when the container was configured, not a re-derivation of the conditions.',
    },
    {
      label: 'CACHE_TYPE',
      value: topology.cacheSetting ?? 'unknown',
      note:
        topology.cacheSetting === 'memory'
          ? 'The in-memory cache is selected, so no Redis client is bound in this container.'
          : 'Redis is bindable in this container.',
    },
    {
      label: 'Redis bound',
      value: topology.redisBound ? 'yes' : 'no',
      note:
        topology.mode === 'home-server'
          ? 'The gateway container is pinned to an in-memory cache in this mode; the realtime lane takes its shared state from REDIS_HOST separately, so "no" here is expected and is not the gate.'
          : 'Whether a Redis client exists in this container.',
    },
    {
      label: 'gRPC syncing proxy bound',
      value: topology.grpcSyncingProxyBound ? 'yes' : 'no',
      note:
        topology.grpcProxyBindableInThisMode === false
          ? 'It cannot be bound in this mode at all — no environment variable will change this.'
          : 'Bound only when SERVICE_PROXY_TYPE is exactly "grpc".',
    },
  ]
}
