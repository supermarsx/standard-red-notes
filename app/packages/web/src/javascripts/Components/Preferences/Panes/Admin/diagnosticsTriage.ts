import { EFFORT_LABEL, type Remedy, type RemedyEffort } from './diagnosticRemedies'
import {
  readingCensus,
  ROW_READINGS,
  SECTION_IDS,
  SECTION_TITLE,
  VERDICT_SEVERITY,
  VERDICTS,
  worstVerdictOf,
  type DiagnosticRow,
  type RowReading,
  type SafeValue,
  type SectionId,
  type SectionModel,
  type Verdict,
} from './diagnosticsSections'

/**
 * Standard Red Notes: the ANSWER, separated from the evidence.
 *
 * *** THE COMPLAINT THIS MODULE EXISTS FOR. *** The pane is not short of data.
 * Measured on a realistic self-hosted deployment, the copyable report is 445
 * lines and 239 rows across 12 sections and 39 blocks, and the reader has to
 * synthesise "is this healthy / what do I fix first" themselves. Worse:
 *
 *   - the first `broken` finding appears at line 171, under three healthy blocks,
 *     and the last one at line 331, under roughly forty more;
 *   - a finding reaches the report as exactly `- Finding: EVENT_QUEUE_SHARED
 *     broken`. No title, no detail and NO REMEDY — `buildSectionModel` dropped
 *     `finding.remedy` on the floor, so nine fully-written remedies existed in
 *     the model and none of them was in the document the operator pastes;
 *   - the same remedy was printed twice where it did reach the report:
 *     `CLIENT_GAP` is raised by two sections, and `SYNCING_SERVER_GRPC_UNBOUND`
 *     and `DEPLOYMENT_UNSTAMPED` are each printed once at the top level and
 *     raised again as a section finding.
 *
 * So this module does three things and renders nothing:
 *
 *   1. ranks every finding in the pane by how much an operator should care,
 *   2. collapses duplicates of one fact into one entry that names every place it
 *      was observed, and
 *   3. counts the three silences, so the summary can say how much of the report
 *      is a reading and how much is an absence.
 *
 * *** THE PUBLIC-PASTE RULE IS UNCHANGED AND IS WHY `title` IS NOT HERE. ***
 * A finding's `title` and `detail` are `string`: prose written by this build, but
 * a type that a builder COULD interpolate a server value into. They stay on the
 * screen. What travels is the `code` — a `SafeValue`, so a literal of this build —
 * the capped `verdict`, the section TITLE (also a `SafeValue`), and the `Remedy`,
 * whose every constructor takes a closed union of literals this build compiled
 * in. Nothing else.
 */

/* -------------------------------------------------------------------------- */
/* One thing to act on                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One item in the ranked list.
 *
 * `sources` is a list because two sections legitimately observe one fact — the
 * capability gap is both a socket matter and an account matter — and the reader
 * needs to know where to look without being shown the entry twice. `code` and
 * every member of `sources` are `SafeValue`s, so an entry cannot carry text this
 * build did not write.
 */
export type ActionItem = {
  readonly code: SafeValue
  readonly verdict: Verdict
  readonly sources: readonly SafeValue[]
  readonly remedy?: Remedy
}

/**
 * Where the report's own top-level blocks contribute an action.
 *
 * The boot gate, the deployment marker and the capability matrix are built by
 * `diagnosticsReport.ts` from the raw payload rather than by a section, so their
 * remedies have no finding to hang on. They are handed in as items instead, and
 * de-duplication then folds them together with the section finding that reports
 * the same thing — which is the whole reason this takes a flat list rather than
 * reading the sections alone.
 */
export type ActionSource = {
  readonly code: SafeValue
  readonly verdict: Verdict
  readonly source: SafeValue
  readonly remedy?: Remedy
}

/**
 * Whether an item is something to DO or something to KNOW.
 *
 * Split rather than ordered-and-truncated, because the two need different
 * treatment in the report: the first list is the answer and is never collapsed,
 * and the second is context and is. `informational` is the only verdict that
 * lands in the second list — `undetermined` does not, deliberately, because a
 * fact the panel could not establish is a thing to act on (run the checks, read
 * the section) and the whole pane exists to stop it reading as a pass.
 */
export const ACTIONABLE_VERDICTS: Record<Verdict, boolean> = {
  broken: true,
  degraded: true,
  undetermined: true,
  healthy: false,
  informational: false,
}

/* -------------------------------------------------------------------------- */
/* The triage                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the summary block needs, all derived and none of it supplied.
 *
 * `sectionsSupplied` is here so the summary can tell "this deployment raised no
 * findings" from "this caller passed no sections". The second is a caller defect
 * and the report says so in words elsewhere; a summary that reported it as a
 * clean bill of health would be the worst single line in the document.
 */
export type Triage = {
  readonly sectionsSupplied: boolean
  /**
   * The worst verdict across the five sections' OWN `worstVerdict` values, which
   * each derive from that section's rows and findings together. `undetermined`
   * when no sections were supplied — never `healthy`.
   */
  readonly sectionWorst: Verdict
  /** Every verdict counted, so a zero is a reading rather than an absent key. */
  readonly counts: Record<Verdict, number>
  /** Ranked worst-first. Each entry is one fact, however many places saw it. */
  readonly actions: readonly ActionItem[]
  /** `informational` and `healthy` findings, same ranking, kept out of the answer. */
  readonly context: readonly ActionItem[]
  /** The single thing to do first, or nothing when there is nothing to do. */
  readonly first: ActionItem | undefined
  /** Row readings across the five sections. Always all three keys. */
  readonly rows: Record<RowReading, number>
  readonly rowTotal: number
  /** How many ranked actions carry no remedy at all. A gap in THIS build. */
  readonly withoutRemedy: number
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The one-word severity each verdict
 * prints as in the ranked list.
 *
 * Upper case and distinct from `VERDICT_CHIP_LABEL`, which is for a chip four
 * characters wide. "UNKNOWN" is spelled out rather than shortened because this is
 * the list someone else reads without the panel: a reader who skims "Unknown" as
 * a shrug is the failure mode the whole `undetermined` verdict exists to prevent.
 */
export const ACTION_SEVERITY_WORD: Record<Verdict, string> = {
  broken: 'BROKEN',
  degraded: 'DEGRADED',
  undetermined: 'UNKNOWN',
  healthy: 'HEALTHY',
  informational: 'CONTEXT',
}

/**
 * The overall word, from the worst verdict the SECTIONS themselves derived.
 *
 * *** NOT FROM THE FINDING COUNTS, AND THAT IS THE WHOLE CARE HERE. *** A pane
 * where every row reads cleanly raises no finding at all, so a word derived from
 * the finding census would be the same word for a perfect deployment and for one
 * nobody read — and `worstVerdictOf` already answers this correctly one level
 * down, from rows AND findings together, for exactly that reason. It is the same
 * number the Overview router and the sub-tab chips rank on, so the headline and
 * the chip beside the tab it points at cannot disagree.
 *
 * *** AN EMPTY PANE IS NOT HEALTHY. *** With no sections supplied this is
 * `UNKNOWN`: `worstVerdictOf` returns `undetermined` for an empty list on the
 * same principle, and a report opening with "HEALTHY" because nothing had been
 * read would be the most expensive line in this project.
 */
export function overallWord(triage: Triage): string {
  return ACTION_SEVERITY_WORD[triage.sectionWorst]
}

const emptyCounts = (): Record<Verdict, number> => ({
  broken: 0,
  degraded: 0,
  undetermined: 0,
  healthy: 0,
  informational: 0,
})

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** Whether an entry can be acted on where
 * it stands, which is the SECOND ranking key.
 *
 * *** THE BUG THIS CLOSES, FOUND BY READING THE OUTPUT. *** On the deployment this
 * pane was built for, the worst thing in the report is a live refusal reason
 * (`sync-not-configured`, `broken`) whose own remedy says "Not fixable here — the
 * unmet boot-gate conditions are the real finding". Ranking purely on severity put
 * it at entry 1 and named it on the `Fix first:` line, so the single most
 * prominent instruction in the document was a pointer at entry 4. An operator
 * mid-incident acting on the ranked list top-down starts with a dead end.
 *
 * `none` is the member that means exactly that — "nothing configuration can do in
 * this topology", tone `bad` — and it is the only one that sorts late. `wait` and
 * `no-action` do NOT: they are complete answers rather than deferrals, and an
 * entry whose honest answer is "nothing, and here is why" is worth reading before
 * one that sends the reader somewhere else. An entry with NO remedy sorts late
 * too, for the same reason as `none`: it cannot be acted on from where it is.
 */
const ACTS_WHERE_IT_STANDS: Record<RemedyEffort, boolean> = {
  'account-setting': true,
  restart: true,
  rebuild: true,
  'peer-service': true,
  device: true,
  'client-update': true,
  'upgrade-server': true,
  wait: true,
  'no-action': true,
  none: false,
}

function actsWhereItStands(item: ActionItem): boolean {
  return item.remedy !== undefined && ACTS_WHERE_IT_STANDS[item.remedy.effort]
}

/**
 * Rank and fold a flat list of observations into one entry per fact.
 *
 * ORDER. Severity descending; then entries that can be ACTED ON where they stand
 * ahead of ones that defer or carry no fix at all; then the order the items were
 * observed — which is `SECTION_IDS` order, the pane's own order, so the ranked
 * list and the detail below it agree about which section comes first. A stable
 * sort is required for that last tier and `Array.prototype.sort` has been stable
 * since ES2019; the severity is compared on `VERDICT_SEVERITY`, which is the same
 * `Record` the sub-tab chips and the Overview router rank on, so the list cannot
 * come to disagree with the chip beside the tab it points at.
 *
 * FOLDING. Keyed on `code`, because a code is the identity of a fact in this pane
 * — it is what `diagnosticFinding` documents as "a stable, closed identifier".
 * The folded entry takes the WORST verdict of its duplicates and the FIRST remedy
 * offered, and accumulates the sources in observation order. Taking the worst
 * matters: the websocket section caps its capability-gap claim on one deployment
 * and the account section does not, and an entry that reported the gentler of the
 * two would understate a real gap.
 */
export function rankActions(observations: readonly ActionSource[]): readonly ActionItem[] {
  const order: SafeValue[] = []
  const byCode = new Map<string, { verdict: Verdict; sources: SafeValue[]; remedy?: Remedy }>()

  for (const observation of observations) {
    const existing = byCode.get(observation.code)
    if (existing === undefined) {
      order.push(observation.code)
      byCode.set(observation.code, {
        verdict: observation.verdict,
        sources: [observation.source],
        ...(observation.remedy === undefined ? {} : { remedy: observation.remedy }),
      })
      continue
    }

    if (VERDICT_SEVERITY[observation.verdict] > VERDICT_SEVERITY[existing.verdict]) {
      existing.verdict = observation.verdict
    }
    if (!existing.sources.includes(observation.source)) {
      existing.sources.push(observation.source)
    }
    if (existing.remedy === undefined && observation.remedy !== undefined) {
      existing.remedy = observation.remedy
    }
  }

  const items: ActionItem[] = order.map((code) => {
    const folded = byCode.get(code) as { verdict: Verdict; sources: SafeValue[]; remedy?: Remedy }

    return {
      code,
      verdict: folded.verdict,
      sources: folded.sources,
      ...(folded.remedy === undefined ? {} : { remedy: folded.remedy }),
    }
  })

  return items.sort((left, right) => {
    const bySeverity = VERDICT_SEVERITY[right.verdict] - VERDICT_SEVERITY[left.verdict]
    if (bySeverity !== 0) {
      return bySeverity
    }

    return Number(actsWhereItStands(right)) - Number(actsWhereItStands(left))
  })
}

/**
 * Every finding in every section, as observations, in the contract's order.
 *
 * Iterated over `SECTION_IDS` rather than over the object's own keys, exactly as
 * the report builder is, so a section cannot be skipped by the order a caller
 * happened to assemble — and a sixth section added to the contract is ranked
 * without anything here changing.
 */
export function observationsFromSections(
  sections: Readonly<Record<SectionId, SectionModel>> | undefined,
): readonly ActionSource[] {
  if (sections === undefined) {
    return []
  }

  const observations: ActionSource[] = []
  for (const id of SECTION_IDS) {
    for (const block of sections[id].blocks) {
      for (const finding of block.findings) {
        observations.push({
          code: finding.code,
          verdict: finding.verdict,
          source: SECTION_TITLE[id],
          ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
        })
      }
    }
  }

  return observations
}

/** Every row in every section, in the contract's order. */
export function rowsFromSections(
  sections: Readonly<Record<SectionId, SectionModel>> | undefined,
): readonly DiagnosticRow[] {
  if (sections === undefined) {
    return []
  }

  const rows: DiagnosticRow[] = []
  for (const id of SECTION_IDS) {
    for (const block of sections[id].blocks) {
      rows.push(...block.rows)
    }
  }

  return rows
}

export function triage(input: {
  sections?: Readonly<Record<SectionId, SectionModel>>
  /** The report's own top-level remedies, which belong to no section. */
  extra?: readonly ActionSource[]
}): Triage {
  const observations = [...observationsFromSections(input.sections), ...(input.extra ?? [])]
  const ranked = rankActions(observations)
  const rows = rowsFromSections(input.sections)

  const counts = emptyCounts()
  for (const item of ranked) {
    counts[item.verdict] += 1
  }

  const actions = ranked.filter((item) => ACTIONABLE_VERDICTS[item.verdict])
  const context = ranked.filter((item) => !ACTIONABLE_VERDICTS[item.verdict])

  const sections = input.sections

  return {
    sectionsSupplied: sections !== undefined,
    sectionWorst:
      sections === undefined ? 'undetermined' : worstVerdictOf(SECTION_IDS.map((id) => sections[id].worstVerdict)),
    counts,
    actions,
    context,
    first: actions[0],
    rows: readingCensus(rows),
    rowTotal: rows.length,
    withoutRemedy: actions.filter((item) => item.remedy === undefined).length,
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering the ranked list as markdown                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a ranked entry says when this build has no remedy for it.
 *
 * It is a statement about the CLIENT, not about the deployment, and it says so:
 * a reader who sees a bare code with nothing under it cannot tell "there is
 * nothing to do" from "nobody wrote the advice", and those are opposite
 * conclusions. Counted in `Triage.withoutRemedy` as well, so the gap is visible
 * as a number rather than only as N silent entries.
 */
export const NO_REMEDY_LINE =
  '  - No fix is recorded in this client build for this finding. That is a gap in the client, not a statement that nothing can be done — read the section named above, which carries the full explanation on screen.'

/**
 * How several observation sources are joined.
 *
 * NOT a comma: `SECTION_TITLE.account` is "Account, space & requirements", so a
 * comma-joined list of three sources reads as four. The separator has to be one
 * no section title contains.
 */
export const SOURCE_JOIN = ' · '

/** The remedy as report lines. Every part is a literal this build compiled in. */
export function remedyLines(remedy: Remedy): readonly string[] {
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

/**
 * One ranked entry, numbered.
 *
 * The number is the whole point of the block: "fix this first" is a claim the
 * report has never made, and an operator mid-incident acting on the wrong one of
 * three broken things is the cost of not making it.
 */
export function actionLines(item: ActionItem, position: number): readonly string[] {
  const lines = [`### ${position}. ${ACTION_SEVERITY_WORD[item.verdict]} — ${item.code}`, '']
  lines.push(`- Seen in: ${item.sources.join(SOURCE_JOIN)}`)
  if (item.remedy === undefined) {
    lines.push(NO_REMEDY_LINE)
  } else {
    lines.push(...remedyLines(item.remedy))
  }
  lines.push('')

  return lines
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE, AND SPELLED OUT. *** The census names all
 * three readings and prints a zero for the ones at zero, unlike the per-block
 * census, which omits them.
 *
 * The difference is deliberate: a block census is read beside its own rows, where
 * an absent group is visible, and this one is the top of a document somebody else
 * reads. "0 have no publisher at all" is a reading — it says every blank below is
 * a question worth asking — and an omitted line is indistinguishable from a
 * report that never counted.
 */
const CENSUS_PHRASE: Record<RowReading, string> = {
  answered: 'carried a value',
  unanswered: 'were asked for and nothing came back',
  unpublished: 'have no publisher at all, so there is nothing to wait for',
}

/** The row census as one sentence, naming all three readings including the zeros. */
export function describeRowCensus(triage: Triage): string {
  if (triage.rowTotal === 0) {
    return 'no rows were produced, so nothing below is a reading'
  }

  const parts = ROW_READINGS.map((reading) => `${triage.rows[reading]} ${CENSUS_PHRASE[reading]}`)

  return `${triage.rowTotal} rows — ${parts.join(', ')}`
}

/**
 * The findings census, naming every verdict including the zeros, same reason —
 * and in SEVERITY order rather than in `VERDICTS` declaration order.
 *
 * `VERDICTS` is declared healthy-first, which is the order a reader of this line
 * least wants: the first number they see should be the one that decides whether
 * they keep reading. Sorted on the same `VERDICT_SEVERITY` the list below it is
 * ranked on, so the counts and the entries cannot come out in different orders.
 *
 * `healthy` is excluded because a finding is never raised for a healthy fact —
 * including it would print a constant zero that reads as a measurement.
 */
export function describeFindingCounts(triage: Triage): string {
  return VERDICTS.filter((verdict) => verdict !== 'healthy')
    .sort((left, right) => VERDICT_SEVERITY[right] - VERDICT_SEVERITY[left])
    .map((verdict) => `${triage.counts[verdict]} ${verdict}`)
    .join(', ')
}
