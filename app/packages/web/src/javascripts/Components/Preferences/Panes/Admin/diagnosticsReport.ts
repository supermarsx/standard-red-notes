import { buildEnvironmentGroups, describeTopology } from './diagnosticEnvironment'
import {
  EFFORT_LABEL,
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnstampedDeployment,
  type DeploymentTopology,
  type Remedy,
} from './diagnosticRemedies'
import {
  buildCapabilityRows,
  describeDeployment,
  describeTransport,
  diagnose,
  sanitizeServerCopy,
  type CapabilityTestOutcome,
  type SyncDiagnosticsPayload,
  type TransportStatusInput,
} from './syncDiagnostics'

/**
 * Standard Red Notes: the whole diagnosis as one block of markdown, for pasting
 * into an issue or a support conversation.
 *
 * *** THIS OUTPUT IS ASSUMED TO BECOME PUBLIC. ***
 *
 * It carries the same secrecy discipline as the panel, held the same structural
 * way rather than by sanitising on the way out:
 *
 *   - Presence, never values. Every configuration line is a variable NAME and a
 *     yes/no. Variable names are public — they are in the compose files.
 *   - No URL, host, port, token or key. Not truncated, not hashed, not partial.
 *     A hashed host is still a host to anyone holding a candidate list.
 *   - Capability tests contribute `reportDetail`, which is constant copy, never
 *     `detail`, which may embed a thrown message carrying the URL that failed.
 *   - The deployment revision IS included. It is already public at
 *     /.well-known/srn-deployment.json, and "which commit is live" is the first
 *     question anyone reading the report will ask.
 *
 * When adding a field, ask whether it is a name, a boolean, a closed enum or a
 * constant. If it is none of those, it does not belong here.
 */

export type DiagnosticsReportInput = {
  payload: SyncDiagnosticsPayload | undefined
  transport: TransportStatusInput | undefined
  deploymentMarker: unknown
  outcomes: readonly CapabilityTestOutcome[]
  loadError: string | null
  /** Injected so the report is deterministic under test. */
  generatedAt?: string
}

const yesNo = (value: boolean | undefined): string => (value === true ? 'yes' : value === false ? 'no' : 'unknown')

/**
 * `capturedAt` is the ONE free-form string the server sends, and echoing it
 * verbatim is a hole: nothing structurally stops a future field, a proxy or a
 * misbehaving build putting something else in it, and the report is pasted in
 * public. So it is admitted only when it is literally an ISO-8601 instant, and
 * reported as malformed otherwise rather than reprinted.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

const safeTimestamp = (value: string | undefined): string => {
  if (value === undefined) {
    return 'not reported'
  }

  return ISO_INSTANT.test(value) ? value : 'reported in an unrecognised format, withheld'
}

const remedyLines = (remedy: Remedy): string[] => {
  const lines = [
    `  - Fix (${EFFORT_LABEL[remedy.effort]}${remedy.basis === 'generic' ? ', generic advice' : ''}): ${remedy.summary}`,
  ]
  for (const step of remedy.steps) {
    lines.push(`    - ${step}`)
  }
  for (const fact of remedy.because) {
    lines.push(`    - Because: ${fact}`)
  }

  return lines
}

export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const { payload, transport, deploymentMarker, outcomes, loadError } = input
  const topology: DeploymentTopology | undefined = payload?.deployment
  const verdict = describeTransport(transport)
  const diagnosis = diagnose(payload, transport)
  const marker = describeDeployment(deploymentMarker)
  const rows = buildCapabilityRows(
    payload?.protocol?.serverOperations ?? [],
    transport?.operations ?? [],
    transport?.state === 'READY' || transport?.state === 'DEGRADED',
  )

  const lines: string[] = []

  lines.push('# Standard Red Notes — capability diagnostics')
  lines.push('')
  lines.push(`Generated: ${input.generatedAt ?? new Date().toISOString()}`)
  lines.push(`Server captured: ${safeTimestamp(payload?.capturedAt)}`)
  lines.push('')
  lines.push(
    'Configuration PRESENCE only. This report deliberately contains no URL, host, port, token or key — only variable names, booleans and closed status codes.',
  )
  lines.push('')

  lines.push('## Verdict')
  lines.push('')
  lines.push(`- Transport in use: ${verdict.label}`)
  lines.push(`- Diagnosis: ${diagnosis.headline}`)
  if (loadError) {
    lines.push(`- Diagnostics endpoint: ${loadError}`)
  }
  lines.push('')

  lines.push('## Deployment')
  lines.push('')
  lines.push(`- Revision: ${marker.revision}`)
  lines.push(`- Version: ${marker.version}`)
  lines.push(`- Stamped: ${marker.unstamped ? 'no' : 'yes'}`)
  if (marker.note) {
    lines.push(`- Note: ${marker.note}`)
  }
  if (marker.unstamped) {
    lines.push(...remedyLines(remedyForUnstampedDeployment()))
  }
  lines.push('')

  lines.push('## Topology')
  lines.push('')
  for (const fact of describeTopology(topology)) {
    lines.push(`- ${fact.label}: ${fact.value} — ${fact.note}`)
  }
  lines.push('')

  lines.push('## Boot gate')
  lines.push('')
  lines.push(`- Recorded: ${yesNo(payload?.gate?.recorded)}`)
  lines.push(`- Sync lane enabled: ${yesNo(payload?.gate?.syncLaneEnabled)}`)
  lines.push(`- SYNC_ITEMS advertised: ${yesNo(payload?.gate?.syncItemsAdvertised)}`)
  lines.push(`- Gateway attached: ${yesNo(payload?.gate?.gatewayAttached)}`)
  lines.push(`- Ticket available: ${yesNo(payload?.live?.ticketAvailable)}`)
  const unmet = payload?.gate?.unmetPreconditions ?? []
  if (unmet.length === 0) {
    lines.push('- Unmet conditions: none')
  } else {
    lines.push('- Unmet conditions:')
    for (const precondition of unmet) {
      lines.push(`  - ${sanitizeServerCopy(precondition.code ?? 'UNKNOWN')}`)
      lines.push(...remedyLines(remedyForPrecondition(precondition.code ?? 'UNKNOWN', precondition.remedy, topology)))
    }
  }
  const liveReasons = payload?.live?.unavailabilityReasons ?? []
  if (liveReasons.length > 0) {
    lines.push('- Live refusal reasons:')
    for (const reason of liveReasons) {
      lines.push(`  - ${sanitizeServerCopy(reason)}`)
      const remedy = remedyForLiveReason(reason, topology)
      if (remedy) {
        lines.push(...remedyLines(remedy))
      }
    }
  }
  if (payload?.gate?.files) {
    lines.push(
      `- FILES_V1 advertised: ${yesNo(payload.gate.files.advertised)}${
        payload.gate.files.unmetCondition ? ` (${sanitizeServerCopy(payload.gate.files.unmetCondition)})` : ''
      }`,
    )
  }
  lines.push('')

  lines.push('## Capabilities')
  lines.push('')
  lines.push('| Operation | Server | Client | Negotiated | Status |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(
      `| ${row.operation} | ${yesNo(row.serverSupported)} | ${yesNo(row.clientImplemented)} | ${yesNo(row.negotiated)} | ${row.status} |`,
    )
  }
  const clientGaps = rows.filter((row) => row.status === 'client-gap').map((row) => row.operation)
  if (clientGaps.length > 0) {
    lines.push('')
    lines.push(...remedyLines(remedyForClientGap(clientGaps)))
  }
  lines.push('')

  lines.push('## Configuration presence')
  lines.push('')
  const groups = buildEnvironmentGroups(topology)
  if (groups.length === 0) {
    lines.push('Not reported by this server build.')
  }
  for (const group of groups) {
    lines.push(`### ${group.title}`)
    lines.push('')
    for (const row of group.rows) {
      lines.push(
        `- ${row.key}: ${row.present ? 'set' : 'not set'} (${row.relevance})${row.note ? ` — ${row.note}` : ''}`,
      )
    }
    lines.push('')
  }

  lines.push('## Checks')
  lines.push('')
  if (outcomes.length === 0) {
    lines.push('Not run.')
  }
  for (const outcome of outcomes) {
    lines.push(`- [${outcome.passed ? 'PASS' : 'FAIL'}] ${outcome.name} — ${outcome.reportDetail}`)
  }
  lines.push('')

  return lines.join('\n')
}
