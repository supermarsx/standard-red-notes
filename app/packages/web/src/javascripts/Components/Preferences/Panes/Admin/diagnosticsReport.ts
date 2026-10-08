import { buildEnvironmentPresence, describeTopology } from './diagnosticEnvironment'
import { admitToken, DEPLOY_REVISION, VERSION_TOKEN } from './reportAllowlist'
import {
  READING_MARKER,
  ROW_READINGS,
  READING_MEANING,
  safeConstant,
  SECTION_IDS,
  SECTION_TITLE,
  type SectionId,
  type SectionModel,
} from './diagnosticsSections'
import {
  ACTION_SEVERITY_WORD,
  actionLines,
  describeFindingCounts,
  describeRowCensus,
  NO_REMEDY_LINE,
  overallWord,
  remedyLines,
  SOURCE_JOIN,
  triage,
  type ActionSource,
} from './diagnosticsTriage'
import {
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnrecognisedPreconditions,
  remedyForUnstampedDeployment,
  TOPOLOGY_ENUM_MEMBERS,
  type ClientGapSubject,
  type DeploymentTopology,
} from './diagnosticRemedies'
import {
  admitMembers,
  buildCapabilityRows,
  CAPABILITY_OUTCOME_REPORT_TAG,
  capabilityOutcomeState,
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
  summarizeTestRun,
  type CapabilityTestOutcome,
  type DiagnosticsReadFailure,
  type KnownLiveRefusalReason,
  type KnownPreconditionCode,
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

export function describeCaptureInstant(value: string | undefined): string {
  if (value === undefined) {
    return 'not reported'
  }

  return ISO_INSTANT.test(value) ? value : 'reported in an unrecognised format, withheld'
}

/**
 * Exported so the PANE can print the same capture instant under the same rule.
 *
 * It used to be private, and the header line the pane now carries would have been
 * a second admission rule for the one free-form string the server sends — which
 * is how a screen comes to print something the report refuses. One function, two
 * surfaces.
 */
const safeTimestamp = describeCaptureInstant

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

/**
 * A collapsible region, so the detail is reachable without burying the answer.
 *
 * *** COLLAPSED, NEVER DROPPED. *** The operator pastes this document to reason
 * about their deployment and several of the quietest rows in it are themselves
 * diagnostic — a row reading "nothing publishes this" is the answer to a question
 * that would otherwise be asked of the pane. So nothing is removed: every line is
 * still in the text, and a reader pasting it somewhere that renders no HTML sees
 * the whole thing exactly as before, with two extra tags.
 *
 * `summary` is composed here from literals of this build, bounded counts and
 * `SafeValue`s, and nothing else may be interpolated into it: it is the one part
 * of a collapsed region a reader sees without opening it.
 */
const collapsible = (summary: string, body: readonly string[]): readonly string[] => [
  '<details>',
  `<summary>${summary}</summary>`,
  '',
  ...body,
  '</details>',
  '',
]

/* -------------------------------------------------------------------------- */
/* The parts both the summary and the whole report are built from              */
/* -------------------------------------------------------------------------- */

const SOURCE_BOOT_GATE = safeConstant('Boot gate')
const SOURCE_DEPLOYMENT = safeConstant('Deployment')
const SOURCE_CAPABILITIES = safeConstant('Capabilities')

/**
 * *** EXHAUSTIVE OVER THE WORDS, AND A GLOSS ONLY WHERE ONE EARNS ITS LINE. ***
 *
 * The overall word is the first thing read and `UNKNOWN` is the one that gets
 * misread: it is the panel admitting it could not establish its facts, and a
 * reader who takes it for a shrug draws exactly the wrong conclusion. The gloss
 * is keyed off `ACTION_SEVERITY_WORD`'s own values so a renamed word cannot leave
 * a stale sentence behind.
 */
const OVERALL_GLOSS: Readonly<Record<string, string>> = {
  [ACTION_SEVERITY_WORD.broken]: ' — at least one thing in this deployment is not working.',
  [ACTION_SEVERITY_WORD.degraded]: ' — everything is working, with something lost.',
  [ACTION_SEVERITY_WORD.undetermined]:
    ' — this pane could not establish its facts. That is NOT the same as everything being fine.',
  [ACTION_SEVERITY_WORD.healthy]: ' — every row the pane could read came back healthy.',
  [ACTION_SEVERITY_WORD.informational]: ' — nothing in the pane carried a verdict either way.',
}

/**
 * The report's OWN contributions to the ranked action list.
 *
 * *** WHY THESE ARE NOT ALREADY FINDINGS. *** The boot gate, the deployment
 * marker and the capability matrix are built in this file straight off the
 * payload, not by a section builder, so their remedies have no `DiagnosticFinding`
 * to hang on — and they used to be printed inline, under the fact they answered,
 * which put three of the most actionable instructions in the pane at lines 20, 48
 * and 108 of a 445-line document, in no particular order, and twice over wherever
 * a section raised the same thing.
 *
 * Handed to `triage` as observations instead. De-duplication is by CODE, and the
 * codes here are deliberately the same literals the sections use
 * (`DEPLOYMENT_UNSTAMPED`, `CLIENT_GAP`, the precondition code, the refusal
 * reason), so one fact produces one entry naming both places it was seen rather
 * than two entries carrying the same advice.
 *
 * Each verdict is the WEAKER of what this file could claim and what the section
 * claims, because `rankActions` folds to the worst and an overstated claim here
 * would raise a section's own capped verdict. `DEPLOYMENT_UNSTAMPED` is the case:
 * Environment & setup caps it to `undetermined` on correlated evidence (two
 * causes, indistinguishable from here), so this does not assert `degraded`.
 */
function reportActionSources(input: {
  topology: DeploymentTopology | undefined
  unstamped: boolean
  unmetNamed: readonly KnownPreconditionCode[]
  unmetUnnameable: number
  liveNamed: readonly KnownLiveRefusalReason[]
  clientGaps: readonly ClientGapSubject[]
}): readonly ActionSource[] {
  const sources: ActionSource[] = []

  if (input.unstamped) {
    sources.push({
      code: safeConstant('DEPLOYMENT_UNSTAMPED'),
      verdict: 'undetermined',
      source: SOURCE_DEPLOYMENT,
      remedy: remedyForUnstampedDeployment(),
    })
  }

  for (const code of input.unmetNamed) {
    sources.push({
      code: safeConstant(code),
      verdict: 'degraded',
      source: SOURCE_BOOT_GATE,
      remedy: remedyForPrecondition(code, input.topology),
    })
  }

  if (input.unmetUnnameable > 0) {
    sources.push({
      code: safeConstant('UNRECOGNISED_BOOT_CONDITIONS'),
      verdict: 'undetermined',
      source: SOURCE_BOOT_GATE,
      remedy: remedyForUnrecognisedPreconditions(input.unmetUnnameable),
    })
  }

  for (const reason of input.liveNamed) {
    const remedy = remedyForLiveReason(reason, input.topology)
    sources.push({
      code: safeConstant(reason),
      verdict: 'broken',
      source: SOURCE_BOOT_GATE,
      ...(remedy === undefined ? {} : { remedy }),
    })
  }

  if (input.clientGaps.length > 0) {
    sources.push({
      code: safeConstant('CLIENT_GAP'),
      verdict: 'degraded',
      source: SOURCE_CAPABILITIES,
      remedy: remedyForClientGap(input.clientGaps),
    })
  }

  return sources
}

/**
 * Everything derived once, so the summary and the whole report cannot disagree.
 *
 * The `Copy summary` button exists because an 18 KB report is not what somebody
 * wants pasted into a chat message, and the one thing worse than a long report is
 * a short one that contradicts it. So there is one derivation and two renderers
 * over it, rather than two readers of the same payload.
 */
type ReportParts = {
  readonly header: readonly string[]
  readonly verdictBlock: readonly string[]
  readonly actionBlock: readonly string[]
  readonly legendBlock: readonly string[]
  readonly detail: readonly string[]
}

function buildParts(input: DiagnosticsReportInput): ReportParts {
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
  // The same rule for the refusal reasons, measured the same way.
  const liveReasons = admitMembers(payload?.live?.unavailabilityReasons ?? [], KNOWN_LIVE_REFUSAL_REASONS)

  // *** THE TABLE NAMES ONLY WHAT THIS BUILD DECLARES. ***
  //
  // An operation name is a SERVER-chosen string, and this matrix printed it
  // through `sanitizeServerCopy` — a denylist, which withheld an address-shaped
  // name from this very table and printed an opaque one into it verbatim. Rows
  // for operations this build cannot name are therefore counted instead:
  // `buildCapabilityRows` already reduces each of them to `UNRECOGNISED_OPERATION`,
  // so what is dropped is only N identical rows, and the count is the fact they
  // carried.
  const named = rows.filter((row) => row.operation !== UNRECOGNISED_OPERATION)
  const unnameable = rows.length - named.length
  const clientGaps = rows.filter((row) => row.status === 'client-gap').map((row) => row.operation)

  const extra = reportActionSources({
    topology,
    unstamped: marker.unstamped,
    unmetNamed: unmet.named,
    unmetUnnameable: unmet.unnameable,
    liveNamed: liveReasons.named,
    clientGaps,
  })
  const triaged = triage({ ...(input.sections === undefined ? {} : { sections: input.sections }), extra })
  const overall = overallWord(triaged)

  /* ------------------------------------------------------------------------ */
  /* Header — the facts a reader must not lose when a paste is trimmed        */
  /* ------------------------------------------------------------------------ */

  const header: string[] = [
    '# Standard Red Notes — capability diagnostics',
    '',
    `Generated: ${input.generatedAt ?? new Date().toISOString()}`,
    `Server captured: ${safeTimestamp(payload?.capturedAt)}`,
    // *** BUILD IDENTITY AT THE TOP, AND DELIBERATELY TWICE. *** It is also a row
    // under `## Deployment`, a hundred-odd lines down and behind a collapsed
    // region. "Which commit is live" is the first question anyone reading this
    // asks, and a paste that gets trimmed is trimmed from the bottom.
    `Build: revision ${marker.unstamped ? marker.revision : admitToken(marker.revision, DEPLOY_REVISION)}, version ${
      marker.unstamped ? marker.version : admitToken(marker.version, VERSION_TOKEN)
    }, stamped ${marker.unstamped ? 'no' : 'yes'}`,
    `Transport in use: ${verdict.label}`,
    '',
  ]

  /* ------------------------------------------------------------------------ */
  /* Verdict — the answer, before any evidence                               */
  /* ------------------------------------------------------------------------ */

  const verdictBlock: string[] = ['## Verdict', '']
  verdictBlock.push(`- Overall: ${overall}${OVERALL_GLOSS[overall] ?? ''}`)
  verdictBlock.push(`- Diagnosis: ${diagnosis.headline}`)
  verdictBlock.push(
    triaged.first === undefined
      ? '- Fix first: nothing. No finding in this pane needs action.'
      : `- Fix first: ${triaged.first.code}, reported by ${triaged.first.sources.join(SOURCE_JOIN)}. It is entry 1 of "What to fix, in order" below.`,
  )
  verdictBlock.push(`- Findings needing action: ${triaged.actions.length} (${describeFindingCounts(triaged)})`)
  verdictBlock.push(`- Evidence below: ${describeRowCensus(triaged)}`)
  verdictBlock.push(`- Operator checks: ${summarizeTestRun(outcomes)}`)
  // Printed at zero as well. "Every ranked finding carries a fix" is a reading
  // about THIS CLIENT, and an absent line is indistinguishable from a report that
  // never counted — the rule every other count in this document follows.
  verdictBlock.push(`- Ranked findings this build has no fix for: ${triaged.withoutRemedy}`)
  if (loadError) {
    verdictBlock.push(`- Diagnostics endpoint: ${loadError}`)
  }
  // The status-branched meaning, included because the most common use of this
  // report is to hand an unread diagnosis to someone else, and the status is the
  // only fact in it that narrows the cause. Constant copy from this build plus a
  // numeric status, so it carries nothing the public-report rule excludes.
  if (readFailure && !payload) {
    const failure = describeDiagnosticsReadFailure(readFailure)
    verdictBlock.push(`- What that means: ${failure.title} — ${failure.detail}`)
  }
  if (!triaged.sectionsSupplied) {
    verdictBlock.push(
      '- Coverage: the five topic sections were not supplied to this report, so the verdict above is derived from the boot gate and the deployment marker alone. That is a caller defect, not a server that reported nothing.',
    )
  }
  verdictBlock.push('')

  /* ------------------------------------------------------------------------ */
  /* What to fix, in order                                                   */
  /* ------------------------------------------------------------------------ */

  const actionBlock: string[] = ['## What to fix, in order', '']
  actionBlock.push(
    'Worst first, one entry per FACT however many sections observed it, ranked on the same severity the sub-tab chips and the Overview router use. Each fix is this build’s own copy for the condition — never the server’s sentence — and says where the fix lives: a setting plus a restart, an image rebuild, another service, this device, a newer build, or nothing at all.',
  )
  actionBlock.push('')
  if (triaged.actions.length === 0) {
    actionBlock.push(
      triaged.sectionsSupplied
        ? 'Nothing needs action. No block in any section raised a finding that is broken, degraded, or that the panel could not establish.'
        : 'Nothing needs action from what this caller supplied — and it supplied no sections, so this is not a clean bill of health. See the Coverage line above.',
    )
    actionBlock.push('')
  }
  triaged.actions.forEach((item, index) => {
    actionBlock.push(...actionLines(item, index + 1))
  })
  if (triaged.context.length > 0) {
    actionBlock.push(
      ...collapsible(
        `Context: ${triaged.context.length} finding(s) that are not faults`,
        triaged.context.flatMap((item) => [
          `### ${ACTION_SEVERITY_WORD[item.verdict]} — ${item.code}`,
          '',
          `- Seen in: ${item.sources.join(SOURCE_JOIN)}`,
          ...(item.remedy === undefined ? [NO_REMEDY_LINE] : remedyLines(item.remedy)),
          '',
        ]),
      ),
    )
  }

  /* ------------------------------------------------------------------------ */
  /* How to read this                                                        */
  /* ------------------------------------------------------------------------ */

  const legendBlock: string[] = ['## How to read this', '']
  legendBlock.push(
    `- Severity, worst first: ${ACTION_SEVERITY_WORD.broken} (it is not working) · ${ACTION_SEVERITY_WORD.degraded} (working, with something lost) · ${ACTION_SEVERITY_WORD.undetermined} (the panel could not establish it — NOT a pass, and ranked above healthy on purpose) · ${ACTION_SEVERITY_WORD.informational} (context, no verdict).`,
  )
  legendBlock.push(
    `- Row markers, on every row of the five topic sections: ${ROW_READINGS.map(
      (reading) => `${READING_MARKER[reading]} ${READING_MEANING[reading]}`,
    ).join(
      ' · ',
    )}. The three are different facts and are never merged: the second invites the question "why not?", the third answers it.`,
  )
  legendBlock.push(
    '- Collapsed regions hold the full detail, unchanged. Nothing is omitted — pasted somewhere that renders no HTML, every line is still here.',
  )
  legendBlock.push(
    '- Configuration PRESENCE only. This report deliberately contains no URL, host, port, token or key — not truncated and not hashed. Every value is a variable NAME, a boolean, a closed status code, a bounded count, a duration or a closed bucket; byte figures are whole megabytes or buckets.',
  )
  legendBlock.push('')

  /* ------------------------------------------------------------------------ */
  /* Detail                                                                  */
  /* ------------------------------------------------------------------------ */

  const detail: string[] = []

  const deploymentBody: string[] = []
  // Admitted by SHAPE, not by the redactor `describeDeployment` applies. That
  // redactor is a denylist and says itself it cannot catch an unstructured secret:
  // a marker reading `token-sk-live-...` has no address shape and printed verbatim,
  // and `v1.2.3-build@<host>` printed with the host removed but the prefix intact.
  // The marker is served by whatever fronts the bundle, and this report is written
  // to be pasted in public, so an unrecognised value is refused rather than
  // repaired. `marker.revision` is already `unstamped` or `—` in those cases,
  // which the patterns reject, so the sentinels are restored explicitly.
  deploymentBody.push(
    `- Revision: ${marker.unstamped ? marker.revision : admitToken(marker.revision, DEPLOY_REVISION)}`,
  )
  deploymentBody.push(`- Version: ${marker.unstamped ? marker.version : admitToken(marker.version, VERSION_TOKEN)}`)
  deploymentBody.push(`- Stamped: ${marker.unstamped ? 'no' : 'yes'}`)
  if (marker.note) {
    deploymentBody.push(`- Note: ${marker.note}`)
  }
  if (marker.unstamped) {
    deploymentBody.push('- Fix: ranked as DEPLOYMENT_UNSTAMPED under "What to fix, in order".')
  }
  deploymentBody.push('')
  detail.push(
    '## Deployment',
    '',
    ...collapsible(`Deployment — ${marker.unstamped ? 'no usable build identity' : 'stamped'}`, deploymentBody),
  )

  const topologyFacts = describeTopology(topology)
  const topologyBody: string[] = []
  for (const fact of topologyFacts) {
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
    topologyBody.push(`- ${fact.label}: ${admitTopologyValue(fact.value)}${fact.note ? ` — ${fact.note}` : ''}`)
  }
  topologyBody.push('')
  detail.push('## Topology', '', ...collapsible(`Topology — ${topologyFacts.length} fact(s)`, topologyBody))

  const gateBody: string[] = []
  gateBody.push(`- Recorded: ${yesNo(payload?.gate?.recorded)}`)
  gateBody.push(`- Sync lane enabled: ${yesNo(payload?.gate?.syncLaneEnabled)}`)
  // Sourced from `syncItems.state`, never from `gate.syncItemsAdvertised`: one
  // source of truth, and the third state has no boolean to read. A server too old
  // to send the verdict reads "could not be determined" here rather than echoing a
  // boolean that build derived from a weaker signal than the handshake's own
  // predicate.
  gateBody.push(`- SYNC_ITEMS advertised: ${SYNC_ITEMS_STATE_REPORT[syncItems.state]}`)
  // The cause is a closed enum this build re-validated against its OWN list, so
  // the code printed here is a literal from this file's build and not server text.
  // `- What that means:` follows the read-failure branch above: constant copy from
  // this build, which is what keeps a pasteable report free of server prose.
  if (syncItems.state !== 'ADVERTISED') {
    if (syncItems.cause) {
      gateBody.push(`- SYNC_ITEMS cause: ${syncItems.cause}`)
    }
    gateBody.push(`- What that means: ${syncItems.title} — ${syncItems.detail}`)
    if (syncItems.remedy) {
      // The server's remedy is a frozen compile-time constant in the contract and
      // goes through the redactor on the way in regardless — the same treatment
      // every precondition remedy in this report already gets.
      gateBody.push(`  - The server reports: ${syncItems.remedy}`)
    }
  }
  gateBody.push(`- Gateway attached: ${yesNo(payload?.gate?.gatewayAttached)}`)
  gateBody.push(`- Ticket available: ${yesNo(payload?.live?.ticketAvailable)}`)
  if (unmet.named.length === 0 && unmet.unnameable === 0) {
    gateBody.push('- Unmet conditions: none')
  } else {
    gateBody.push('- Unmet conditions:')
    for (const code of unmet.named) {
      gateBody.push(`  - ${code}`)
    }
    // Printed at zero as well, exactly as the capability and presence counts are:
    // "every condition the gate named was one this build knows" is a reading, and
    // an absent line is indistinguishable from a report that never asked.
    gateBody.push(`  - Conditions this build does not recognise: ${unmet.unnameable}`)
    gateBody.push('  - Every condition above is ranked under "What to fix, in order", with the fix for THIS topology.')
  }
  if (liveReasons.named.length > 0 || liveReasons.unnameable > 0) {
    gateBody.push('- Live refusal reasons:')
    for (const reason of liveReasons.named) {
      gateBody.push(`  - ${reason}`)
    }
    gateBody.push(`  - Reasons this build does not recognise: ${liveReasons.unnameable}`)
  }
  if (payload?.gate?.files) {
    // The sub-gate's condition is one of four literals this build declares, and it
    // is admitted against them rather than redacted: `UNRECOGNISED_FILES_CONDITION`
    // is a constant from `syncDiagnostics.ts`, so this line cannot carry a
    // server-chosen string whatever the server sends.
    const filesCondition = payload.gate.files.unmetCondition
    gateBody.push(
      `- FILES_V1 advertised: ${yesNo(payload.gate.files.advertised)}${
        filesCondition
          ? ` (${isKnownFilesUnmetCondition(filesCondition) ? filesCondition : UNRECOGNISED_FILES_CONDITION})`
          : ''
      }`,
    )
  }
  gateBody.push('')
  detail.push(
    '## Boot gate',
    '',
    ...collapsible(
      `Boot gate — ${unmet.named.length + unmet.unnameable} unmet condition(s), ${
        liveReasons.named.length + liveReasons.unnameable
      } live refusal reason(s)`,
      gateBody,
    ),
  )

  const capabilityBody: string[] = []
  capabilityBody.push('| Operation | Server | Client | Negotiated | Status |')
  capabilityBody.push('| --- | --- | --- | --- | --- |')
  for (const row of named) {
    capabilityBody.push(
      `| ${row.operation} | ${yesNo(row.serverSupported)} | ${yesNo(row.clientImplemented)} | ${yesNo(row.negotiated)} | ${row.status} |`,
    )
  }
  capabilityBody.push('')
  // Printed at zero as well: "none that this build cannot name" is a reading, and
  // an absent line would be indistinguishable from a report that never asked.
  capabilityBody.push(`- Operations this build does not recognise: ${unnameable}`)
  if (clientGaps.length > 0) {
    capabilityBody.push('- Fix: ranked as CLIENT_GAP under "What to fix, in order".')
  }
  capabilityBody.push('')
  detail.push(
    '## Capabilities',
    '',
    ...collapsible(`Capabilities — ${named.length} named, ${unnameable} unrecognised`, capabilityBody),
  )

  // *** THE ROWS NAME ONLY WHAT THIS BUILD DECLARES. ***
  //
  // `row.key` is a `KnownEnvKey`, so every name below is a literal compiled into
  // this build; a server-chosen key cannot reach this line. It could, and did: a
  // key off the wire was put in that field through `sanitizeServerCopy` — a
  // denylist — and a probe over the live payload measured the result. An
  // address-SHAPED key was withheld and two opaque ones printed verbatim into this
  // very block, in a document written to be pasted in public. They are counted
  // instead.
  const presence = buildEnvironmentPresence(topology)
  const presenceBody: string[] = []
  if (!presence.reported) {
    presenceBody.push('Not reported by this server build.')
    presenceBody.push('')
  }
  let presenceRows = 0
  for (const group of presence.groups) {
    presenceBody.push(`### ${group.title}`)
    presenceBody.push('')
    for (const row of group.rows) {
      presenceRows += 1
      presenceBody.push(
        `- ${row.key}: ${row.present ? 'set' : 'not set'} (${row.relevance})${row.note ? ` — ${row.note}` : ''}`,
      )
    }
    presenceBody.push('')
  }
  // Printed at zero as well, exactly as the capability count is: "none this build
  // cannot name" is a reading, and an absent line is indistinguishable from a
  // report that never asked.
  if (presence.reported) {
    presenceBody.push(
      `- Variables reported by a newer server that this build does not recognise: ${presence.unrecognised}`,
    )
    if (presence.unrecognised > 0) {
      presenceBody.push(
        '  - Counted and never named. A presence key is chosen by the server, so it is server-controlled text like any value, and this document is written to be pasted in public. The count is the diagnosis: variables this build has no guidance for put the gap on the client, and a client update is what closes it.',
      )
    }
    presenceBody.push('')
  }
  detail.push(
    '## Configuration presence',
    '',
    ...collapsible(
      presence.reported
        ? `Configuration presence — ${presenceRows} variable(s), ${presence.unrecognised} unrecognised`
        : 'Configuration presence — not reported by this server build',
      presenceBody,
    ),
  )

  const checksBody: string[] = []
  if (outcomes.length === 0) {
    checksBody.push('Not run.')
  }
  for (const outcome of outcomes) {
    checksBody.push(
      `- [${CAPABILITY_OUTCOME_REPORT_TAG[capabilityOutcomeState(outcome)]}] ${outcome.name} — ${outcome.reportDetail}`,
    )
  }
  checksBody.push('')
  detail.push('## Checks', '', ...collapsible(`Checks — ${summarizeTestRun(outcomes)}`, checksBody))

  // The five topic sections. Iterated over SECTION_IDS, not over the caller's
  // object, so the order is the pane's order and no section can be skipped.
  if (input.sections === undefined) {
    detail.push(
      'The five topic sections were not supplied to this report, so WebSocket, Environment & setup, Database & internal comms, Account, space & requirements and Browser are missing from it. That is a caller defect, not a server that reported nothing.',
    )
    detail.push('')
  } else {
    detail.push(
      'The five topic sections follow, each with the worst verdict it derived from its own rows and findings. Every value in them is a variable name, a boolean, a closed code, a bounded count, a duration or a closed bucket.',
    )
    detail.push('')
    for (const id of SECTION_IDS) {
      const model = input.sections[id]
      detail.push(
        ...collapsible(`${SECTION_TITLE[id]} — ${ACTION_SEVERITY_WORD[model.worstVerdict]}`, [
          ...model.reportLines,
          '',
        ]),
      )
    }
  }

  return { header, verdictBlock, actionBlock, legendBlock, detail }
}

/**
 * The ANSWER on its own, for the `Copy summary` button.
 *
 * It is the header, the verdict, the ranked action list and the legend — and
 * deliberately not one row of evidence. The reason it exists is that the whole
 * report is 18 KB and the thing an operator wants to paste into a chat message is
 * the first fifty lines of it; the reason it is built from the same `buildParts`
 * as the report is that a summary which disagreed with the document it summarises
 * would be worse than no summary at all.
 */
export function buildDiagnosticsSummary(input: DiagnosticsReportInput): string {
  const parts = buildParts(input)

  return [
    ...parts.header,
    ...parts.verdictBlock,
    ...parts.actionBlock,
    ...parts.legendBlock,
    'This is the SUMMARY only. The full report adds the deployment marker, the topology, the boot gate, the capability matrix, configuration presence, the operator checks and all five topic sections, each behind a collapsed region.',
    '',
  ].join('\n')
}

export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const parts = buildParts(input)

  return [...parts.header, ...parts.verdictBlock, ...parts.actionBlock, ...parts.legendBlock, ...parts.detail].join(
    '\n',
  )
}
