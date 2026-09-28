import { admitToken, DEPLOY_REVISION, VERSION_TOKEN } from './reportAllowlist'
import { describeDeployment, describeTransport, type TransportStatusInput } from './syncDiagnostics'

/**
 * Standard Red Notes: the Health & Services readout as one block of markdown,
 * for pasting into an issue or a support conversation.
 *
 * *** THIS OUTPUT IS ASSUMED TO BECOME PUBLIC. ***
 *
 * A copy button makes a diagnostic far more likely to be pasted somewhere the
 * person cannot take it back, so the bar for what may appear here is HIGHER than
 * for the on-screen panel, not the same.
 *
 * HELD BY ALLOWLIST, NOT BY STRIPPING. Every value below is admitted only by
 * passing a shape predicate — a boolean, a closed enum, a bounded integer, or a
 * token matching a strict pattern. Anything that does not match is replaced by a
 * constant refusal string. That is deliberately the opposite of scrubbing known
 * bad shapes out of free text: a denylist can only remove what it has seen
 * before (`sanitizeServerCopy` says so itself), and the fields here are supplied
 * by a server we do not control.
 *
 * Consequences worth knowing when extending this:
 *   - `ServerService.detail` is NEVER printed. It is free-form and is exactly
 *     where a probe failure puts the URL or host it could not reach.
 *   - `network.trustProxy` and `network.clientIpHeader` are printed as PRESENCE
 *     only. Their values are a CIDR list and a header name — address-shaped.
 *   - `health.auth.status` is free-form and is reported as a presence, not echoed.
 *   - The deployment revision IS printed. It is already public at
 *     /.well-known/srn-deployment.json and is the first thing a reader needs.
 *
 * PROVENANCE IS SEPARATED. Facts this client knows on its own are reported apart
 * from facts the server supplied, and a server that did not answer produces
 * "the server did not answer", never "no". Those are materially different
 * claims, and conflating them is what previously turned one 401 into a report
 * that appeared to say the server had refused every capability.
 */

export type HealthReportInput = {
  /** Raw `adminGetServerStatus()` payload. Untrusted; read by allowlist only. */
  serverStatus: unknown
  /** Raw docker-control payload. Untrusted. */
  dockerControl: unknown
  /** This client's own live transport state. Known locally; no server call. */
  transport: TransportStatusInput | undefined
  /** Raw /.well-known/srn-deployment.json body. Untrusted. */
  deploymentMarker: unknown
  /** Why the server status could not be read, if it could not. */
  statusError: string | null
  /** Whether the viewer holds the admin role, which gates the server half. */
  isAdmin?: boolean
  /** Injected so the report is deterministic under test. */
  generatedAt?: string
}

/** Supervisord program / service-row names: lowercase, hyphenated, bounded. */
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,63}$/
/** Negotiated socket operation names, e.g. SYNC_ITEMS. */
const OPERATION_NAME = /^[A-Z][A-Z0-9_]{0,31}$/

const SERVICE_STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const
/** Containers the server may offer to restart. Anything else is not named. */
const KNOWN_CONTAINERS = ['cache', 'db'] as const
/** Dependency checks auth reports. Unknown keys are counted, never named. */
const KNOWN_AUTH_CHECKS = ['db', 'redis'] as const
/** Assistant providers this build knows. An operator-added name is not echoed. */
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'ollama', 'openrouter'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** yes / no / unknown — the only thing a boolean may become. */
const flag = (value: unknown): string => (value === true ? 'yes' : value === false ? 'no' : 'unknown')

/**
 * For a value whose CONTENT may never be printed. Says whether it is configured,
 * which is the whole diagnostic question, and nothing about what it says.
 */
const presence = (value: unknown): string => {
  if (value === undefined || value === null) {
    return 'not set (built-in default)'
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? 'set (value withheld)' : 'not set (built-in default)'
  }
  return 'unknown'
}

const admitEnum = <T extends string>(value: unknown, allowed: readonly T[]): string => {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value : 'unknown'
}

/** A non-negative integer, bounded so a hostile number cannot become a long string. */
const admitCount = (value: unknown): string => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000
    ? String(value)
    : 'unknown'
}

const admitLatency = (value: unknown): string => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600_000
    ? `${Math.round(value)} ms`
    : 'not measured'
}

export function buildHealthReport(input: HealthReportInput): string {
  const status = isRecord(input.serverStatus) ? input.serverStatus : undefined
  const health = isRecord(status?.health) ? status.health : undefined
  const auth = isRecord(health?.auth) ? health.auth : undefined
  const gateway = isRecord(health?.gateway) ? health.gateway : undefined
  const network = isRecord(status?.network) ? status.network : undefined
  const switches = isRecord(status?.masterSwitches) ? status.masterSwitches : undefined
  const docker = isRecord(input.dockerControl) ? input.dockerControl : undefined
  const services = Array.isArray(status?.services) ? status.services : []

  const marker = describeDeployment(input.deploymentMarker)
  const verdict = describeTransport(input.transport)
  const serverAnswered = status !== undefined

  const lines: string[] = []

  lines.push('# Standard Red Notes — health & services')
  lines.push('')
  lines.push(`Generated: ${input.generatedAt ?? new Date().toISOString()}`)
  lines.push('')
  lines.push(
    'Configuration PRESENCE only. This report deliberately contains no URL, host, port, token or key — only variable names, booleans and closed status codes.',
  )
  lines.push('')
  lines.push(
    'Facts are grouped by who knows them: this client can report its own transport with no server call, while everything under "Reported by the server" needs the admin status endpoint.',
  )
  lines.push('')

  lines.push('## Known by this client')
  lines.push('')
  lines.push(`- Sync transport in use: ${verdict.label}`)
  // Operation names are this build's own closed union, not server text, but they
  // are admitted by shape anyway so the rule has no exceptions to remember.
  const operations = (input.transport?.operations ?? []).map((operation) => admitToken(operation, OPERATION_NAME))
  lines.push(`- Negotiated operations: ${operations.length > 0 ? operations.join(', ') : 'none'}`)
  lines.push(`- Fallback reason: ${input.transport?.fallbackReason ?? 'none'}`)
  lines.push('')

  lines.push('## Deployment')
  lines.push('')
  // `describeDeployment` passes these through `sanitizeServerCopy`, which is a
  // DENYLIST and says itself that it cannot catch an unstructured secret. The
  // marker is served by whatever fronts the bundle, so both fields are re-admitted
  // here by shape: the revision is the 40 lowercase hex the Dockerfile validates,
  // or the `unstamped` sentinel, and nothing else is printed.
  lines.push(`- Revision: ${marker.unstamped ? 'unstamped' : admitToken(marker.revision, DEPLOY_REVISION)}`)
  lines.push(`- Version: ${marker.unstamped ? 'unstamped' : admitToken(marker.version, VERSION_TOKEN)}`)
  lines.push(`- Stamped: ${marker.unstamped ? 'no' : 'yes'}`)
  lines.push('')

  lines.push('## Reported by the server')
  lines.push('')
  if (!serverAnswered) {
    lines.push(
      `- The server did not answer the status endpoint${
        input.isAdmin === false ? ', and this account does not hold the admin role that endpoint requires' : ''
      }. Nothing below could be read — this is NOT a report that the server answered "no".`,
    )
    if (input.statusError) {
      lines.push(`- Reported reason: ${admitEnum(errorKind(input.statusError), ERROR_KINDS)}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`- Auth server reachable: ${flag(auth?.reachable)}`)
  lines.push(`- Auth status detail: ${presence(auth?.status)}`)
  const checks = isRecord(auth?.checks) ? auth.checks : undefined
  for (const check of KNOWN_AUTH_CHECKS) {
    if (checks && check in checks) {
      lines.push(`- Auth dependency "${check}": ${flag(checks[check])}`)
    }
  }
  const extraChecks = checks
    ? Object.keys(checks).filter((key) => !(KNOWN_AUTH_CHECKS as readonly string[]).includes(key))
    : []
  if (extraChecks.length > 0) {
    lines.push(`- Additional auth dependencies reported (names withheld): ${admitCount(extraChecks.length)}`)
  }
  lines.push(`- Gateway cache (Redis): ${flag(gateway?.redis)}`)
  lines.push('')

  lines.push('## Services')
  lines.push('')
  if (services.length === 0) {
    lines.push('- No services reported.')
  } else {
    lines.push(`- Services reported: ${admitCount(services.length)}`)
    for (const entry of services) {
      if (!isRecord(entry)) {
        continue
      }
      const name = admitToken(entry.name, SERVICE_NAME)
      lines.push(
        `- ${name}: status ${admitEnum(entry.status, SERVICE_STATUSES)}, reachable ${flag(entry.reachable)}, latency ${admitLatency(entry.responseTimeMs)}`,
      )
    }
    lines.push('')
    lines.push(
      'Per-service failure detail is deliberately omitted: it is free-form server text and is where a probe failure puts the address it could not reach.',
    )
  }
  lines.push('')

  lines.push('## Infrastructure containers')
  lines.push('')
  lines.push(`- Container control enabled: ${flag(docker?.enabled)}`)
  lines.push(`- docker-socket-proxy reachable: ${flag(docker?.available)}`)
  const containers = Array.isArray(docker?.containers) ? docker.containers : []
  const namedContainers = containers.filter(
    (container): container is string =>
      typeof container === 'string' && (KNOWN_CONTAINERS as readonly string[]).includes(container),
  )
  lines.push(`- Controllable containers: ${namedContainers.length > 0 ? namedContainers.join(', ') : 'none'}`)
  if (containers.length > namedContainers.length) {
    lines.push(
      `- Additional containers reported (names withheld): ${admitCount(containers.length - namedContainers.length)}`,
    )
  }
  lines.push('')

  lines.push('## Feature switches')
  lines.push('')
  lines.push(`- OCR server: ${flag(switches?.ocrServerEnabled)}`)
  lines.push(`- Workflows: ${flag(switches?.workflowsEnabled)}`)
  lines.push(`- Assistant configured: ${flag(switches?.assistantConfigured)}`)
  const providers = Array.isArray(switches?.assistantProviders) ? switches.assistantProviders : []
  const namedProviders = providers.filter(
    (provider): provider is string =>
      typeof provider === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(provider),
  )
  lines.push(
    `- Assistant providers: ${namedProviders.length > 0 ? namedProviders.join(', ') : 'none recognised'}${
      providers.length > namedProviders.length
        ? ` (+${admitCount(providers.length - namedProviders.length)} unrecognised, names withheld)`
        : ''
    }`,
  )
  lines.push(`- Update check configured: ${flag(switches?.updateCheckConfigured)}`)
  lines.push(`- Current version: ${admitToken(switches?.currentVersion, VERSION_TOKEN)}`)
  lines.push('')

  lines.push('## Network (presence only)')
  lines.push('')
  lines.push(`- TRUST_PROXY: ${presence(network?.trustProxy)}`)
  lines.push(`- CLIENT_IP_HEADER: ${presence(network?.clientIpHeader)}`)
  lines.push('')

  return lines.join('\n')
}

/** Closed set of reasons the status read can fail, so no server text is echoed. */
const ERROR_KINDS = ['unauthorized', 'forbidden', 'not-found', 'unreachable', 'other'] as const

/**
 * Maps a load-error message to a closed code. The message itself is built by this
 * build, but it interpolates a server status code, and it is not worth making the
 * one free-form string in the report an exception to the rule.
 */
export function errorKind(message: string): (typeof ERROR_KINDS)[number] {
  if (message.includes('401')) {
    return 'unauthorized'
  }
  if (message.includes('403')) {
    return 'forbidden'
  }
  if (message.includes('404')) {
    return 'not-found'
  }
  if (/could not reach|unreachable|network/i.test(message)) {
    return 'unreachable'
  }
  return 'other'
}
