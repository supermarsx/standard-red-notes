import {
  ACTION_SEVERITY_WORD,
  ACTIONABLE_VERDICTS,
  actionLines,
  describeFindingCounts,
  describeRowCensus,
  NO_REMEDY_LINE,
  observationsFromSections,
  overallWord,
  rankActions,
  remedyLines,
  rowsFromSections,
  SOURCE_JOIN,
  triage,
  type ActionSource,
} from './diagnosticsTriage'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  NOT_PUBLISHED,
  safeConstant,
  safeCount,
  safeState,
  safeYesNo,
  SECTION_IDS,
  SECTION_TITLE,
  VERDICTS,
  type SectionId,
  type SectionModel,
  type Verdict,
} from './diagnosticsSections'
import type { Remedy } from './diagnosticRemedies'

/**
 * The triage is the ANSWER half of the pane, and the four things it must never do
 * are each pinned here:
 *
 *   - rank a `broken` finding below a healthy one, which is how the first `broken`
 *     finding in the report came to sit at line 171 of 445;
 *   - print one fact twice because two sections observed it;
 *   - report an entry with no fix as though there were nothing to do;
 *   - open with "HEALTHY" over a pane that read nothing.
 */

const remedy = (code: string): Remedy => ({
  code,
  summary: `do the thing for ${code}`,
  steps: [`step for ${code}`],
  effort: 'restart',
  basis: 'verified',
  because: [`because of ${code}`],
})

const observation = (code: string, verdict: Verdict, source: string, withRemedy = true): ActionSource => ({
  code: safeConstant(code as 'A'),
  verdict,
  source: safeConstant(source as 'S'),
  ...(withRemedy ? { remedy: remedy(code) } : {}),
})

/** A section carrying one finding, one healthy row and one silent row. */
const sectionWith = (
  id: SectionId,
  findings: { code: string; verdict: Verdict; remedy?: Remedy }[],
  extraRows: number = 0,
): SectionModel =>
  buildSectionModel({
    id,
    blocks: [
      {
        heading: safeConstant('Block'),
        description: 'd',
        rows: [
          diagnosticRow({
            label: safeConstant('Answered'),
            value: safeState(true, 'attached', 'not attached'),
            verdict: 'healthy',
            evidence: EVIDENCE_DIRECT,
            note: 'n',
          }),
          ...Array.from({ length: extraRows }, (_, index) =>
            diagnosticRow({
              label: safeConstant(`Silent ${index}` as 'Silent'),
              value: safeCount(undefined),
              verdict: 'healthy',
              evidence: EVIDENCE_ABSENT,
              note: 'n',
            }),
          ),
        ],
        findings: findings.map((finding) =>
          diagnosticFinding({
            code: safeConstant(finding.code as 'C'),
            title: `title ${finding.code}`,
            detail: 'detail',
            verdict: finding.verdict,
            evidence: EVIDENCE_DIRECT,
            ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
          }),
        ),
      },
    ],
  })

const sections = (
  per: Partial<Record<SectionId, { code: string; verdict: Verdict; remedy?: Remedy }[]>>,
  extraRows = 0,
): Record<SectionId, SectionModel> => {
  const built = {} as Record<SectionId, SectionModel>
  for (const id of SECTION_IDS) {
    built[id] = sectionWith(id, per[id] ?? [], extraRows)
  }

  return built
}

describe('rankActions', () => {
  it('orders worst first, on the pane’s own severity', () => {
    const ranked = rankActions([
      observation('INFO', 'informational', 'A'),
      observation('UNKNOWN', 'undetermined', 'B'),
      observation('BROKEN', 'broken', 'C'),
      observation('DEGRADED', 'degraded', 'D'),
    ])

    expect(ranked.map((item) => String(item.code))).toEqual(['BROKEN', 'DEGRADED', 'UNKNOWN', 'INFO'])
  })

  /**
   * Within one severity the order is the order the observations arrived, which is
   * `SECTION_IDS` order — the pane's own. A sort that reordered equals would make
   * the ranked list and the detail below it disagree about which section comes
   * first, for no gain.
   */
  it('keeps the observation order within one severity', () => {
    const ranked = rankActions([
      observation('FIRST', 'broken', 'A'),
      observation('SECOND', 'broken', 'B'),
      observation('THIRD', 'broken', 'C'),
    ])

    expect(ranked.map((item) => String(item.code))).toEqual(['FIRST', 'SECOND', 'THIRD'])
  })

  /**
   * *** THE SECOND RANKING KEY, AND THE BUG IT CLOSES. ***
   *
   * On the deployment this pane was built for, the worst finding is a live refusal
   * reason whose own remedy reads "Not fixable here — the unmet boot-gate
   * conditions are the real finding". Ranked on severity alone it was entry 1 and
   * it was what the `Fix first:` line named, so the most prominent instruction in
   * the document pointed at entry 4 and an operator working top-down started with
   * a dead end.
   */
  it('puts an entry that can be acted on ahead of one of equal severity that defers', () => {
    const deferring: ActionSource = {
      code: safeConstant('DEFERS'),
      verdict: 'broken',
      source: safeConstant('A'),
      remedy: { ...remedy('DEFERS'), effort: 'none' },
    }
    const ranked = rankActions([deferring, observation('ACTIONABLE', 'broken', 'B')])

    expect(ranked.map((item) => String(item.code))).toEqual(['ACTIONABLE', 'DEFERS'])
  })

  it('puts an entry with no fix at all behind one of equal severity that has one', () => {
    const ranked = rankActions([observation('NO_FIX', 'degraded', 'A', false), observation('HAS_FIX', 'degraded', 'B')])

    expect(ranked.map((item) => String(item.code))).toEqual(['HAS_FIX', 'NO_FIX'])
  })

  /**
   * `wait` and `no-action` are COMPLETE answers, not deferrals, so they keep their
   * place. "Nothing, and here is why" is worth reading before an entry that sends
   * the reader somewhere else.
   */
  it('does not demote an entry whose complete answer is to wait or to do nothing', () => {
    for (const effort of ['wait', 'no-action'] as const) {
      const complete: ActionSource = {
        code: safeConstant('COMPLETE'),
        verdict: 'degraded',
        source: safeConstant('A'),
        remedy: { ...remedy('COMPLETE'), effort },
      }
      const ranked = rankActions([complete, observation('OTHER', 'degraded', 'B')])

      expect(ranked.map((item) => String(item.code))).toEqual(['COMPLETE', 'OTHER'])
    }
  })

  /** Severity still wins: a deferring broken entry outranks an actionable degraded one. */
  it('never lets the second key overtake the first', () => {
    const deferring: ActionSource = {
      code: safeConstant('BROKEN_DEFERS'),
      verdict: 'broken',
      source: safeConstant('A'),
      remedy: { ...remedy('BROKEN_DEFERS'), effort: 'none' },
    }
    const ranked = rankActions([observation('DEGRADED_ACTIONABLE', 'degraded', 'B'), deferring])

    expect(ranked.map((item) => String(item.code))).toEqual(['BROKEN_DEFERS', 'DEGRADED_ACTIONABLE'])
  })

  it('folds one code observed twice into one entry naming both places', () => {
    const ranked = rankActions([
      observation('CLIENT_GAP', 'degraded', 'WebSocket'),
      observation('CLIENT_GAP', 'degraded', 'Account'),
    ])

    expect(ranked).toHaveLength(1)
    expect(ranked[0].sources.map(String)).toEqual(['WebSocket', 'Account'])
  })

  /**
   * *** THE FOLD TAKES THE WORST, AND THAT IS NOT COSMETIC. *** One section caps a
   * claim on weaker evidence than another does — the capability gap is capped in
   * one place and direct in another — and an entry that reported the gentler of
   * the two would understate a real fault at the top of the document.
   */
  it('takes the worst verdict of a folded code, whichever order it is seen in', () => {
    const forwards = rankActions([observation('X', 'undetermined', 'A'), observation('X', 'broken', 'B')])
    const backwards = rankActions([observation('X', 'broken', 'A'), observation('X', 'undetermined', 'B')])

    expect(forwards[0].verdict).toBe('broken')
    expect(backwards[0].verdict).toBe('broken')
  })

  it('does not list one source twice when a section observes a code twice', () => {
    const ranked = rankActions([observation('X', 'broken', 'A'), observation('X', 'broken', 'A')])

    expect(ranked[0].sources.map(String)).toEqual(['A'])
  })

  it('keeps the first remedy offered, and takes a later one when the first had none', () => {
    const laterRemedy = rankActions([observation('X', 'broken', 'A', false), observation('X', 'broken', 'B')])
    expect(laterRemedy[0].remedy?.code).toBe('X')

    const earlierRemedy = rankActions([observation('X', 'broken', 'A'), observation('Y', 'broken', 'B')])
    expect(earlierRemedy[0].remedy?.summary).toBe('do the thing for X')
  })

  it('reports no remedy at all when none was offered', () => {
    expect(rankActions([observation('X', 'broken', 'A', false)])[0].remedy).toBeUndefined()
  })
})

describe('observationsFromSections', () => {
  it('walks the contract’s sections in the contract’s order, not the object’s', () => {
    const built = sections({
      browser: [{ code: 'LAST', verdict: 'broken' }],
      websocket: [{ code: 'FIRST', verdict: 'broken' }],
    })
    // Deliberately assembled in the wrong order; the walk must not follow it.
    const reversed = {
      browser: built.browser,
      account: built.account,
      backend: built.backend,
      environment: built.environment,
      websocket: built.websocket,
    } as Record<SectionId, SectionModel>

    expect(observationsFromSections(reversed).map((item) => String(item.code))).toEqual(['FIRST', 'LAST'])
  })

  it('tags each observation with its section’s own title', () => {
    const built = sections({ backend: [{ code: 'Q', verdict: 'broken' }] })

    expect(String(observationsFromSections(built)[0].source)).toBe(String(SECTION_TITLE.backend))
  })

  it('claims nothing from an absent sections object', () => {
    expect(observationsFromSections(undefined)).toEqual([])
    expect(rowsFromSections(undefined)).toEqual([])
  })
})

describe('triage', () => {
  it('counts every verdict, including the zeros', () => {
    const result = triage({ sections: sections({ websocket: [{ code: 'X', verdict: 'broken' }] }) })

    for (const verdict of VERDICTS) {
      expect(result.counts[verdict]).toBeGreaterThanOrEqual(0)
    }
    expect(result.counts.broken).toBe(1)
    expect(result.counts.degraded).toBe(0)
  })

  it('splits the things to act on from the things to know', () => {
    const result = triage({
      sections: sections({
        websocket: [{ code: 'B', verdict: 'broken' }],
        browser: [{ code: 'I', verdict: 'informational' }],
      }),
    })

    expect(result.actions.map((item) => String(item.code))).toEqual(['B'])
    expect(result.context.map((item) => String(item.code))).toEqual(['I'])
    expect(String(result.first?.code)).toBe('B')
  })

  /**
   * `undetermined` is ACTIONABLE. The whole pane exists because a fact the panel
   * could not establish used to read as a pass, and sorting it into the collapsed
   * "context" list would be that defect returning one level up.
   */
  it('treats an undetermined finding as something to act on, not as context', () => {
    expect(ACTIONABLE_VERDICTS.undetermined).toBe(true)
    const result = triage({ sections: sections({ account: [{ code: 'U', verdict: 'undetermined' }] }) })

    expect(result.actions.map((item) => String(item.code))).toEqual(['U'])
    expect(result.context).toEqual([])
  })

  it('counts how many ranked actions this build has no fix for', () => {
    const result = triage({
      sections: sections({
        websocket: [
          { code: 'WITH', verdict: 'broken', remedy: remedy('WITH') },
          { code: 'WITHOUT', verdict: 'broken' },
        ],
      }),
    })

    expect(result.withoutRemedy).toBe(1)
  })

  it('censuses the rows of every section, with all three readings present', () => {
    const result = triage({ sections: sections({}, 3) })

    // Five sections, one answered row plus three silent rows each.
    expect(result.rowTotal).toBe(SECTION_IDS.length * 4)
    expect(result.rows.answered).toBe(SECTION_IDS.length)
    expect(result.rows.unanswered).toBe(SECTION_IDS.length * 3)
    expect(result.rows.unpublished).toBe(0)
  })

  /**
   * *** THE THIRD SILENCE, EXERCISED. *** No production row currently uses
   * `NOT_PUBLISHED` — every field it was reserved for turned out to have a
   * producer — so the `unpublished` arm of the census has no caller in the tree
   * and would otherwise be an untested branch that the report's own legend
   * advertises. It is driven directly here.
   */
  it('counts a row whose field nothing publishes as its own third reading', () => {
    const model = buildSectionModel({
      id: 'account',
      blocks: [
        {
          heading: safeConstant('Block'),
          description: 'd',
          rows: [
            diagnosticRow({
              label: safeConstant('Nothing publishes this'),
              value: NOT_PUBLISHED,
              verdict: 'informational',
              evidence: EVIDENCE_ABSENT,
              note: 'n',
            }),
          ],
          findings: [],
        },
      ],
    })
    const result = triage({
      sections: { ...sections({}), account: model },
    })

    expect(result.rows.unpublished).toBe(1)
    expect(describeRowCensus(result)).toContain('1 have no publisher at all')
  })

  it('merges the report’s own observations with the sections’', () => {
    const result = triage({
      sections: sections({ environment: [{ code: 'DEPLOYMENT_UNSTAMPED', verdict: 'undetermined' }] }),
      extra: [observation('DEPLOYMENT_UNSTAMPED', 'undetermined', 'Deployment')],
    })

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].sources.map(String)).toEqual([String(SECTION_TITLE.environment), 'Deployment'])
    // The section finding carried none in this fixture; the report's did.
    expect(result.actions[0].remedy).toBeDefined()
  })

  it('says whether the sections were supplied at all', () => {
    expect(triage({}).sectionsSupplied).toBe(false)
    expect(triage({ sections: sections({}) }).sectionsSupplied).toBe(true)
  })
})

describe('overallWord', () => {
  /**
   * *** AN EMPTY PANE IS NOT HEALTHY, AND A PANE WITH NO FINDINGS IS NOT UNKNOWN. ***
   *
   * Both halves matter, and they pull in opposite directions: a word derived from
   * the finding census says UNKNOWN for a perfect deployment, and one derived from
   * nothing at all says HEALTHY for a pane that read nothing. It is derived from
   * the sections' own worst verdicts, which already answer this correctly.
   */
  it('is UNKNOWN with no sections supplied, and never HEALTHY', () => {
    const word = overallWord(triage({}))

    expect(word).toBe(ACTION_SEVERITY_WORD.undetermined)
    expect(word).not.toBe(ACTION_SEVERITY_WORD.healthy)
  })

  it('is HEALTHY when every section read cleanly and raised nothing', () => {
    expect(overallWord(triage({ sections: sections({}) }))).toBe(ACTION_SEVERITY_WORD.healthy)
  })

  it('takes the worst section verdict, not the worst finding verdict', () => {
    // No findings at all, and a section whose rows alone are undetermined.
    const silent = triage({ sections: sections({}, 1) })
    expect(silent.counts.broken).toBe(0)
    expect(overallWord(silent)).toBe(ACTION_SEVERITY_WORD.undetermined)

    const broken = triage({ sections: sections({ backend: [{ code: 'X', verdict: 'broken' }] }) })
    expect(overallWord(broken)).toBe(ACTION_SEVERITY_WORD.broken)
  })
})

describe('the rendered lines', () => {
  it('numbers each entry, names its severity and its sources, and prints the fix', () => {
    const lines = actionLines(rankActions([observation('EVENT_QUEUE_SHARED', 'broken', 'Database')])[0], 1).join('\n')

    expect(lines).toContain('### 1. BROKEN — EVENT_QUEUE_SHARED')
    expect(lines).toContain('- Seen in: Database')
    expect(lines).toContain('- Fix (Config + restart): do the thing for EVENT_QUEUE_SHARED')
    expect(lines).toContain('    - step for EVENT_QUEUE_SHARED')
    expect(lines).toContain('    - Because: because of EVENT_QUEUE_SHARED')
  })

  /**
   * An entry with no fix must SAY it has none. A silent entry is read as "there is
   * nothing to do", which is the opposite of "nobody wrote the advice".
   */
  it('says so when this build has no fix, rather than printing an entry with nothing under it', () => {
    const lines = actionLines(rankActions([observation('X', 'broken', 'A', false)])[0], 2).join('\n')

    expect(lines).toContain('### 2. BROKEN — X')
    expect(lines).toContain(NO_REMEDY_LINE)
    expect(lines).toContain('gap in the client')
    expect(lines).not.toContain('- Fix (')
  })

  /**
   * *** NOT A COMMA. *** `SECTION_TITLE.account` is "Account, space & requirements",
   * so a comma-joined list of three sources reads as four.
   */
  it('joins sources with a separator no section title contains', () => {
    const lines = actionLines(
      rankActions([
        observation('X', 'broken', String(SECTION_TITLE.account)),
        observation('X', 'broken', String(SECTION_TITLE.browser)),
      ])[0],
      1,
    ).join('\n')

    expect(lines).toContain(`- Seen in: ${SECTION_TITLE.account}${SOURCE_JOIN}${SECTION_TITLE.browser}`)
    for (const title of Object.values(SECTION_TITLE)) {
      expect(String(title)).not.toContain(SOURCE_JOIN)
    }
  })

  it('marks a generic remedy as generic, so a reader can tell derived advice from a default', () => {
    const generic = { ...remedy('X'), basis: 'generic' as const }

    expect(remedyLines(generic).join('\n')).toContain('generic advice')
    expect(remedyLines(remedy('X')).join('\n')).not.toContain('generic advice')
  })

  it('names every verdict in the finding census, worst first, including the zeros', () => {
    const census = describeFindingCounts(
      triage({ sections: sections({ websocket: [{ code: 'X', verdict: 'broken' }] }) }),
    )

    expect(census).toBe('1 broken, 0 degraded, 0 undetermined, 0 informational')
    // `healthy` is never a finding, so a constant zero for it would read as a
    // measurement of something nobody raises.
    expect(census).not.toContain('healthy')
  })

  it('names all three readings in the row census, including the zeros', () => {
    const census = describeRowCensus(triage({ sections: sections({}, 2) }))

    expect(census).toContain('carried a value')
    expect(census).toContain('were asked for and nothing came back')
    expect(census).toContain('0 have no publisher at all')
  })

  it('says so rather than printing zeros when no rows were produced at all', () => {
    expect(describeRowCensus(triage({}))).toContain('no rows were produced')
  })
})

describe('secrecy', () => {
  /**
   * The ranked list carries a finding's CODE and its section TITLE — both
   * `SafeValue`s — and its `Remedy`, whose constructors take closed unions of
   * literals this build compiled in. It does NOT carry `title` or `detail`, which
   * are plain `string`s a builder could interpolate a server value into.
   *
   * Driven by building a finding whose title and detail ARE the planted value, and
   * then asserting the rendered entry is non-empty: an absence assertion over an
   * entry that was never rendered proves nothing.
   */
  const PLANTED = 'redis://admin:hunter2@redis.internal.example:6379'

  it('cannot carry a finding’s prose, and still renders the entry', () => {
    const model = buildSectionModel({
      id: 'websocket',
      blocks: [
        {
          heading: safeConstant('Block'),
          description: PLANTED,
          rows: [
            diagnosticRow({
              label: safeConstant('Row'),
              value: safeYesNo(true),
              verdict: 'healthy',
              evidence: EVIDENCE_DIRECT,
              note: PLANTED,
            }),
          ],
          findings: [
            diagnosticFinding({
              code: safeConstant('PUSH_BRIDGE_ABSENT'),
              title: PLANTED,
              detail: PLANTED,
              verdict: 'broken',
              evidence: EVIDENCE_DIRECT,
            }),
          ],
        },
      ],
    })
    const result = triage({ sections: { ...sections({}), websocket: model } })
    const rendered = result.actions.flatMap((item, index) => actionLines(item, index + 1)).join('\n')

    expect(rendered).not.toContain('hunter2')
    expect(rendered).not.toMatch(/redis:\/\//)
    // NOT vacuous: the entry the planted fields feed really is rendered.
    expect(rendered).toContain('### 1. BROKEN — PUSH_BRIDGE_ABSENT')
    expect(rendered).toContain('Seen in: WebSocket')
  })
})
