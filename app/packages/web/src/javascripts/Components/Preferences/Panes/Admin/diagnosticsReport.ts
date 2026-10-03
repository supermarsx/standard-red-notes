import { buildEnvironmentPresence, describeTopology } from './diagnosticEnvironment'
import { admitToken, DEPLOY_REVISION, VERSION_TOKEN } from './reportAllowlist'
import { SECTION_IDS, type SectionId, type SectionModel } from './diagnosticsSections'
import {
  EFFORT_LABEL,
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnrecognisedPreconditions,
  remedyForUnstampedDeployment,
  TOPOLOGY_ENUM_MEMBERS,
  type DeploymentTopology,
  type Remedy,
} from './diagnosticRemedies'
import {
  admitMembers,
  buildCapabilityRows,
  describeDeployment,
  describeDiagnosticsReadFailure,
  describeSyncItems,
  describeTransport,
  diagnose,
  isKnownFilesUnmetCondition,
  KNOWN_LIVE_REFUSAL_REASONS,
  KNOWN_PRECONDITION_CODES,
  SYNC_ITEMS_STATE_REPORT,
  UNRECOGNISED_FILES_CONDITION,
  UNRECOGNISED_OPERATION,
  type CapabilityTestOutcome,
  type DiagnosticsReadFailure,
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
 *   - Operation names are NAMED only where this build declares them and COUNTED
 *     otherwise. They are server-chosen strings; the table used to print them
 *     through the redactor, which withheld an address-shaped one and printed
 *     an opaque one, with no address shape to match, verbatim.
 *   - The same rule for configuration-presence KEYS, which are chosen by the
 *     server for the same reason: an object's keys are as much its content as
 *     its values. `## Configuration presence` printed them through that same
 *     redactor, and a probe over the live payload measured it — address-shaped
 *     withheld, opaque printed intact. Only `KnownEnvKey` reaches a row now; the
 *     rest are a count.
 *   - The same rule again for the BOOT GATE's own strings — a precondition code,
 *     a live refusal reason, the FILES_V1 sub-gate's condition, and the remedy
 *     sentence the server sends with each. Those are the server's enums and its
 *     prose, and this block printed all four through that same redactor. Measured
 *     on the live stack over its real payload: a marker-built value with no
 *     address shape printed intact, and so did one shaped exactly like a
 *     legitimate upper snake case condition code. Only a member of
 *     `KNOWN_PRECONDITION_CODES`, `KNOWN_LIVE_REFUSAL_REASONS` or
 *     `KNOWN_FILES_UNMET_CONDITIONS` reaches a line now; the rest are a count,
 *     and the remedy is this build's own copy for the admitted member.
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
  /**
   * The read failure behind `loadError`, when there was one. Carried separately
   * so the report's Diagnosis line gets the SAME status-branched guidance the
   * panel shows, rather than re-deriving a cause from the sentence — and so an
   * unread diagnostics endpoint is never reported as a verdict about the socket.
   */
  readFailure?: DiagnosticsReadFailure
  /**
   * The five section models, as a COMPLETE `Record` over `SectionId`.
   *
   * Typed as a record rather than a list so a section cannot be left out by
   * forgetting it: the compiler requires every member, and this builder iterates
   * `SECTION_IDS` rather than whatever order a caller happened to assemble. The
   * user asked for a pasteable report early in this project and it has to keep
   * covering the whole pane — a report that silently omits a section is worse
   * than no report, because the reader cannot tell an omitted section from a
   * section that had nothing to say.
   *
   * Optional only so the many call sites that predate the sections keep working.
   * When it is absent the report SAYS SO, in words, rather than quietly ending
   * four sections early.
   *
   * Nothing here needs sanitising on the way out. Every line of a section's
   * `reportLines` is a `SafeValue`, obtainable only from the constructors in
   * `diagnosticsSections.ts` — a name, a boolean, a closed enum, a bounded count,
   * a duration, a bucket or a literal from this build.
   */
  sections?: Readonly<Record<SectionId, SectionModel>>
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

/**
 * Everything a `describeTopology` fact can legitimately say: the members of the
 * closed-union topology fields, plus the four literals that helper writes itself
 * (`'unknown'` for an absent field, `'yes'`/`'no'` for the two booleans, and
 * `'not reported'` for an unrecorded topology).
 */
const TOPOLOGY_FACT_VALUES: readonly string[] = [...TOPOLOGY_ENUM_MEMBERS, 'unknown', 'yes', 'no', 'not reported']

/**
 * Refused rather than repaired, the same way an unrecognised deployment marker is
 * — this document is written to be pasted in public, and a topology field is an
 * enum with a known member list, so nothing outside it needs printing at all.
 */
const admitTopologyValue = (value: string): string => {
  return TOPOLOGY_FACT_VALUES.includes(value) ? value : 'withheld (unrecognised)'
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
  const { payload, transport, deploymentMarker, outcomes, loadError, readFailure } = input
  const topology: DeploymentTopology | undefined = payload?.deployment
  const verdict = describeTransport(transport)
  const diagnosis = diagnose(payload, transport, readFailure)
  const syncItems = describeSyncItems(payload)
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
  // The status-branched meaning, included because the most common use of this
  // report is to hand an unread diagnosis to someone else, and the status is the
  // only fact in it that narrows the cause. Constant copy from this build plus a
  // numeric status, so it carries nothing the public-report rule excludes.
  if (readFailure && !payload) {
    const failure = describeDiagnosticsReadFailure(readFailure)
    lines.push(`- What that means: ${failure.title} — ${failure.detail}`)
  }
  lines.push('')

  lines.push('## Deployment')
  lines.push('')
  // Admitted by SHAPE, not by the redactor `describeDeployment` applies. That
  // redactor is a denylist and says itself it cannot catch an unstructured secret:
  // a marker reading `token-sk-live-...` has no address shape and printed verbatim,
  // and `v1.2.3-build@<host>` printed with the host removed but the prefix intact.
  // The marker is served by whatever fronts the bundle, and this report is written
  // to be pasted in public, so an unrecognised value is refused rather than repaired.
  // `marker.revision` is already `unstamped` or `—` in those cases, which the
  // patterns reject, so the sentinels are restored explicitly.
  lines.push(`- Revision: ${marker.unstamped ? marker.revision : admitToken(marker.revision, DEPLOY_REVISION)}`)
  lines.push(`- Version: ${marker.unstamped ? marker.version : admitToken(marker.version, VERSION_TOKEN)}`)
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
    // The VALUE is admitted against this build's own member list, and the note is
    // printed only when there is one. `describeTopology` flattens four closed-union
    // topology fields with `topology.mode ?? 'unknown'` and friends — raw — and the
    // whole point of `knownToken` is that those unions are a compile-time claim
    // about JSON cast at the boundary. Measured, not theorised: a topology with an
    // opaque string in all four fields printed all four verbatim into this block,
    // and `modeNote[topology.mode ?? 'unset']` printed the literal "undefined" as
    // the note. This block is the ONLY consumer of that helper, so admitting here
    // closes it; the five sections re-derive their own values through `safeEnum`
    // and never had the hole.
    lines.push(`- ${fact.label}: ${admitTopologyValue(fact.value)}${fact.note ? ` — ${fact.note}` : ''}`)
  }
  lines.push('')

  lines.push('## Boot gate')
  lines.push('')
  lines.push(`- Recorded: ${yesNo(payload?.gate?.recorded)}`)
  lines.push(`- Sync lane enabled: ${yesNo(payload?.gate?.syncLaneEnabled)}`)
  // Sourced from `syncItems.state`, never from `gate.syncItemsAdvertised`: one
  // source of truth, and the third state has no boolean to read. A server too old
  // to send the verdict reads "could not be determined" here rather than echoing a
  // boolean that build derived from a weaker signal than the handshake's own
  // predicate.
  lines.push(`- SYNC_ITEMS advertised: ${SYNC_ITEMS_STATE_REPORT[syncItems.state]}`)
  // The cause is a closed enum this build re-validated against its OWN list, so
  // the code printed here is a literal from this file's build and not server text.
  // `- What that means:` follows the read-failure branch above: constant copy from
  // this build, which is what keeps a pasteable report free of server prose.
  if (syncItems.state !== 'ADVERTISED') {
    if (syncItems.cause) {
      lines.push(`- SYNC_ITEMS cause: ${syncItems.cause}`)
    }
    lines.push(`- What that means: ${syncItems.title} — ${syncItems.detail}`)
    if (syncItems.remedy) {
      // The server's remedy is a frozen compile-time constant in the contract and
      // goes through the redactor on the way in regardless — the same treatment
      // every precondition remedy in this report already gets.
      lines.push(`  - The server reports: ${syncItems.remedy}`)
    }
  }
  lines.push(`- Gateway attached: ${yesNo(payload?.gate?.gatewayAttached)}`)
  lines.push(`- Ticket available: ${yesNo(payload?.live?.ticketAvailable)}`)
  // *** THE CONDITIONS NAME ONLY WHAT THIS BUILD DECLARES. ***
  //
  // Both halves of an unmet precondition were server-chosen strings printed here
  // through `sanitizeServerCopy` — the code on its own line, the remedy through
  // `remedyForPrecondition`'s generic branch — and a probe over the live payload
  // measured the result: a marker-built value with no address shape in either
  // field printed intact into this block, as did one shaped exactly like a
  // legitimate condition code. `admitMembers` returns the members beside the
  // count of what it refused, so the names and the number cannot be separated.
  const unmet = admitMembers(
    (payload?.gate?.unmetPreconditions ?? []).map((precondition) => precondition.code),
    KNOWN_PRECONDITION_CODES,
  )
  if (unmet.named.length === 0 && unmet.unnameable === 0) {
    lines.push('- Unmet conditions: none')
  } else {
    lines.push('- Unmet conditions:')
    for (const code of unmet.named) {
      lines.push(`  - ${code}`)
      lines.push(...remedyLines(remedyForPrecondition(code, topology)))
    }
    // Printed at zero as well, exactly as the capability and presence counts
    // below are: "every condition the gate named was one this build knows" is a
    // reading, and an absent line is indistinguishable from a report that never
    // asked.
    lines.push(`  - Conditions this build does not recognise: ${unmet.unnameable}`)
    if (unmet.unnameable > 0) {
      lines.push(...remedyLines(remedyForUnrecognisedPreconditions(unmet.unnameable)))
    }
  }
  // The same rule for the refusal reasons, measured the same way.
  const liveReasons = admitMembers(payload?.live?.unavailabilityReasons ?? [], KNOWN_LIVE_REFUSAL_REASONS)
  if (liveReasons.named.length > 0 || liveReasons.unnameable > 0) {
    lines.push('- Live refusal reasons:')
    for (const reason of liveReasons.named) {
      lines.push(`  - ${reason}`)
      const remedy = remedyForLiveReason(reason, topology)
      if (remedy) {
        lines.push(...remedyLines(remedy))
      }
    }
    lines.push(`  - Reasons this build does not recognise: ${liveReasons.unnameable}`)
  }
  if (payload?.gate?.files) {
    // The sub-gate's condition is one of four literals this build declares, and
    // it is admitted against them rather than redacted: `UNRECOGNISED_FILES_CONDITION`
    // is a constant from `syncDiagnostics.ts`, so this line cannot carry a
    // server-chosen string whatever the server sends.
    const filesCondition = payload.gate.files.unmetCondition
    lines.push(
      `- FILES_V1 advertised: ${yesNo(payload.gate.files.advertised)}${
        filesCondition
          ? ` (${isKnownFilesUnmetCondition(filesCondition) ? filesCondition : UNRECOGNISED_FILES_CONDITION})`
          : ''
      }`,
    )
  }
  lines.push('')

  lines.push('## Capabilities')
  lines.push('')
  // *** THE TABLE NAMES ONLY WHAT THIS BUILD DECLARES. ***
  //
  // An operation name is a SERVER-chosen string, and this matrix printed it
  // through `sanitizeServerCopy` — a denylist, which withheld
  // an address-shaped name from this very table and printed an opaque one into it
  // verbatim. Rows for operations this build cannot name are therefore
  // counted below instead: `buildCapabilityRows` already reduces each of them to
  // `UNRECOGNISED_OPERATION`, so what is dropped here is only N identical rows,
  // and the count is the fact they carried.
  const named = rows.filter((row) => row.operation !== UNRECOGNISED_OPERATION)
  const unnameable = rows.length - named.length
  lines.push('| Operation | Server | Client | Negotiated | Status |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of named) {
    lines.push(
      `| ${row.operation} | ${yesNo(row.serverSupported)} | ${yesNo(row.clientImplemented)} | ${yesNo(row.negotiated)} | ${row.status} |`,
    )
  }
  lines.push('')
  // Printed at zero as well: "none that this build cannot name" is a reading, and
  // an absent line would be indistinguishable from a report that never asked.
  lines.push(`- Operations this build does not recognise: ${unnameable}`)
  const clientGaps = rows.filter((row) => row.status === 'client-gap').map((row) => row.operation)
  if (clientGaps.length > 0) {
    lines.push('')
    lines.push(...remedyLines(remedyForClientGap(clientGaps)))
  }
  lines.push('')

  lines.push('## Configuration presence')
  lines.push('')
  // *** THE ROWS NAME ONLY WHAT THIS BUILD DECLARES. ***
  //
  // `row.key` is a `KnownEnvKey`, so every name below is a literal compiled into
  // this build; a server-chosen key cannot reach this line. It could, and did: a
  // key off the wire was put in that field through `sanitizeServerCopy` — a
  // denylist — and a probe over the live payload measured the result. An
  // address-SHAPED key was withheld and two opaque ones printed verbatim into
  // this very block, in a document written to be pasted in public. They are
  // counted below instead.
  const presence = buildEnvironmentPresence(topology)
  if (!presence.reported) {
    lines.push('Not reported by this server build.')
  }
  for (const group of presence.groups) {
    lines.push(`### ${group.title}`)
    lines.push('')
    for (const row of group.rows) {
      lines.push(
        `- ${row.key}: ${row.present ? 'set' : 'not set'} (${row.relevance})${row.note ? ` — ${row.note}` : ''}`,
      )
    }
    lines.push('')
  }
  // Printed at zero as well, exactly as the capability count above is: "none
  // this build cannot name" is a reading, and an absent line is indistinguishable
  // from a report that never asked.
  if (presence.reported) {
    lines.push(`- Variables reported by a newer server that this build does not recognise: ${presence.unrecognised}`)
    if (presence.unrecognised > 0) {
      lines.push(
        '  - Counted and never named. A presence key is chosen by the server, so it is server-controlled text like any value, and this document is written to be pasted in public. The count is the diagnosis: variables this build has no guidance for put the gap on the client, and a client update is what closes it.',
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

  // The five topic sections. Iterated over SECTION_IDS, not over the caller's
  // object, so the order is the pane's order and no section can be skipped.
  if (input.sections === undefined) {
    lines.push(
      'The five topic sections were not supplied to this report, so WebSocket, Environment & setup, Database & internal comms, Account, space & requirements and Browser are missing from it. That is a caller defect, not a server that reported nothing.',
    )
    lines.push('')
  } else {
    lines.push(
      'The five topic sections follow, each with the worst verdict it derived from its own rows and findings. Every value in them is a variable name, a boolean, a closed code, a bounded count, a duration or a closed bucket.',
    )
    lines.push('')
    for (const id of SECTION_IDS) {
      lines.push(...input.sections[id].reportLines)
      lines.push('')
    }
  }

  return lines.join('\n')
}
