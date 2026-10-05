import type { DeploymentTopology } from './diagnosticRemedies'
import type { Tone } from './syncDiagnostics'

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
 *
 * *** AND THE KEY IS NOT A NAME THIS BUILD CHOSE. ***
 *
 * `presence` is an object off the wire, so its KEYS are server-controlled text
 * exactly as much as any value would be. This module used to put a key it had
 * never heard of straight into a row — through `sanitizeServerCopy`, a denylist
 * that says in its own comment that it cannot catch an unstructured secret — and
 * both consumers printed the result: the copyable report's `## Configuration
 * presence`, and the Environment section's rows. A probe over the payload the
 * live stack actually returns settled what that bought: an address-SHAPED key was
 * withheld, and two opaque keys — nothing for a pattern to match — printed
 * verbatim, one of them in a row an operator reads and in a document whose single
 * purpose is to be pasted into an issue. Shape-admission is no answer either: a
 * key in upper snake case LOOKS like a variable name and is still whatever the
 * server put there.
 *
 * So the rule here is the rule the rest of this pane arrived at: NAME ONLY WHAT
 * THIS BUILD'S OWN CLOSED SET CONTAINS, AND COUNT THE REST. `EnvironmentRow.key`
 * is typed `KnownEnvKey` — the union of the literals in `GROUPS` — so a wire key
 * in that field does not compile, and `isKnownEnvKey` runs the same check at
 * runtime because a type is erased and one cast would otherwise reopen this
 * silently. What the operator loses is a string they have never seen; what they
 * keep is `unrecognised`, which says how many and therefore which side the gap is
 * on. Nothing is dropped quietly, which is the failure mode this view exists to
 * end.
 */

export type EnvironmentRelevance =
  | 'required' /** Read in this topology, and the lane needs it. */
  | 'optional' /** Read in this topology; absence is a supported configuration. */
  | 'inert' /** Present or not, this topology never reads it. */
  | 'unknown' /** Topology not reported; no claim is made. */

export type EnvironmentRow = {
  /**
   * A variable name THIS BUILD declares, never one off the wire.
   *
   * Typed as the closed union rather than `string` so that the leak this view
   * had is a compile error at the call site instead of something a redactor is
   * asked to catch: `key: someServerKey` does not compile. A key the server
   * reports and this build has no name for is counted in
   * `EnvironmentPresence.unrecognised` and never becomes a row.
   */
  key: KnownEnvKey
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

/**
 * Everything this view can say about a presence block: the variables it can
 * NAME, grouped, and how many it cannot.
 *
 * One object rather than a bare array of groups so that a consumer cannot take
 * the rows and silently leave the count behind — adding it to the return type
 * fails every existing call site to compile until it has been read, which is the
 * only way this file can make a consumer report a fact it has no row for.
 */
export type EnvironmentPresence = {
  groups: EnvironmentGroup[]
  /**
   * Variables the server reported that this build has no name for. COUNTED and
   * never named: a presence key is server-chosen text. The count is the useful
   * half anyway — it says the gap is on the client, where an echoed name says
   * nothing a reader can act on.
   */
  unrecognised: number
  /**
   * Whether the server reported a presence block at all. Distinct from an empty
   * one: "nothing was reported" and "nothing unrecognised was reported" are
   * different readings, and this view must never let a consumer confuse them.
   */
  reported: boolean
}

const GROUPS = [
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
    description:
      'Optional. Absent on single-node deployments, which fan events out in-process instead. Two queue names rather than one: the PREFIXED one is what gives the gateway a queue of its own.',
    keys: ['SQS_QUEUE_URL', 'API_GATEWAY_SQS_QUEUE_URL', 'SNS_TOPIC_ARN'],
  },
  {
    title: 'Deployment identity',
    description: 'Answers "which build is live". Baked at image build time; see the Deployment section.',
    keys: ['SRN_DEPLOY_REVISION', 'SRN_DEPLOY_VERSION'],
  },
] as const satisfies readonly { title: string; description: string; keys: readonly string[] }[]

/**
 * Every variable name this build declares, as a closed union of literals.
 *
 * Derived from `GROUPS` rather than written out beside it: a second list would
 * be a second thing to keep in step, and the whole value of this union is that
 * it cannot disagree with the rows.
 */
export type KnownEnvKey = (typeof GROUPS)[number]['keys'][number]

/**
 * Every declared name, flat. Exported so a test can hold the two rules that
 * govern a label together: a key this build declares must also satisfy the name
 * shape `safeEnvName` floors labels against, or a real variable would render as
 * though it were a withheld secret.
 */
export const DECLARED_ENV_KEYS: readonly KnownEnvKey[] = GROUPS.flatMap((group) => group.keys)

const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set<string>(DECLARED_ENV_KEYS)

/**
 * The runtime half of the member check.
 *
 * The TYPE is the guarantee — a server-supplied key cannot be assigned to
 * `EnvironmentRow.key` at all — and this is the same check at runtime, because a
 * type is erased: one cast at a future call site would otherwise reopen the hole
 * with nothing to see in the diff. An ALLOW-list, not a scrub: a key is either a
 * literal this build compiled in or it is counted.
 */
export function isKnownEnvKey(key: string): key is KnownEnvKey {
  return KNOWN_ENV_KEYS.has(key)
}

/**
 * Typed as a set of MEMBERS rather than of strings so a typo here is a compile
 * error. It used to be `Set<string>`, where a misspelled entry silently promoted
 * a variable from optional to required — a row reading `bad` on a deployment
 * that is configured correctly.
 */
const OPTIONAL_KEYS: ReadonlySet<KnownEnvKey> = new Set<KnownEnvKey>([
  'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
  'PUBLIC_URL',
  'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
  'REDIS_PORT',
  'SQS_QUEUE_URL',
  'API_GATEWAY_SQS_QUEUE_URL',
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
  key: KnownEnvKey,
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

  /**
   * *** THE PREFIXED QUEUE NAME IS OPTIONAL IN EVERY TOPOLOGY, AND IS NEVER THE
   * SAME ANSWER AS ITS UNPREFIXED SIBLING. ***
   *
   * `API_GATEWAY_SQS_QUEUE_URL` is a PROJECTION SOURCE rather than a knob the
   * gateway reads under that name: the container writes the gateway's dotenv with
   * `printenv | sed -n 's/^API_GATEWAY_//p'`, so this variable arrives in the
   * process as the bare `SQS_QUEUE_URL` the code actually reads. Its presence is
   * therefore the evidence that the gateway has a queue OF ITS OWN, and its
   * absence beside a set bare name is the evidence that it is reading a queue
   * configured for something else.
   *
   * `required` would be wrong everywhere. Absence is a supported configuration in
   * every topology: a deployment with no queue at all fans events out in-process,
   * and a deployment with a queue but no second consumer has nothing to separate
   * from. `inert` would also be wrong, and more subtly: the projection runs
   * unconditionally, so a value set here IS read — what differs by topology is
   * whether it is worth setting. So the relevance is `optional` and the TOPOLOGY
   * is carried in the note, which is where a judgement that depends on the shape
   * of the deployment belongs.
   */
  if (key === 'API_GATEWAY_SQS_QUEUE_URL') {
    if (homeServer) {
      return {
        relevance: 'optional',
        note: present
          ? 'Set, and nothing on a single container needs it: this shape forces in-process event fan-out, and one process cannot split a queue with itself. Harmless.'
          : 'Not needed on a single container, which forces in-process event fan-out. There is no sibling consumer here to take a queue of its own from.',
      }
    }

    return {
      relevance: 'optional',
      note: present
        ? 'Set, which is the evidence that this gateway has a queue of its own rather than the one the workers consume. Presence only — no address is read — and it cannot show that the two queues are actually different, nor that a second consumer exists.'
        : 'Not set, so this gateway reads whatever the bare SQS_QUEUE_URL points at. That is correct on a deployment with no other consumer and is the measured defect on one with workers: a queue delivers each message once, so two consumers SPLIT the traffic instead of each seeing it. The Database & internal comms section reads this same pair as a prefix state.',
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

export function buildEnvironmentPresence(topology: DeploymentTopology | undefined): EnvironmentPresence {
  const recorded = topology?.recorded === true
  const presence = topology?.presence ?? {}
  const reportedKeys = Object.keys(presence)

  const groups = GROUPS.map((group) => ({
    title: group.title,
    description: group.description,
    rows: group.keys
      // `isKnownEnvKey` cannot fail on a key read out of `GROUPS` — that is the
      // point of it. It is here as the runtime floor under the type, so that a
      // later edit feeding this map anything off the wire drops the row and
      // counts it instead of printing it.
      .filter((key) => isKnownEnvKey(key) && key in presence)
      .map((key) => {
        const present = presence[key] === true
        const { relevance, note } = recorded
          ? classify(key, present, topology as DeploymentTopology)
          : { relevance: 'unknown' as EnvironmentRelevance, note: '' }

        return { key, present, relevance, tone: TONES[relevance](present), note }
      }),
  })).filter((group) => group.rows.length > 0)

  // A newer server reporting a key this client build has never heard of must not
  // vanish — an unknown-but-reported variable is still evidence, and a silently
  // dropped row is the failure mode this whole panel was built to end. It is
  // reported as a COUNT: the key is server-chosen text, and "two variables this
  // build does not recognise" tells the operator the gap is on the client, which
  // two names they have never seen do not.
  return {
    groups,
    unrecognised: reportedKeys.filter((key) => !isKnownEnvKey(key)).length,
    reported: reportedKeys.length > 0,
  }
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
