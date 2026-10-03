import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  blockWorstVerdict,
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  ENV_NAME,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  isBlockEmpty,
  LANE_REJECTION_STATUSES,
  outcomesForSection,
  PERCENT_BUCKETS,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safeEnvName,
  safePercentBucket,
  safePresence,
  safeState,
  safeTokens,
  safeYesNo,
  SECTION_IDS,
  SECTION_TITLE,
  TONE_FOR_VERDICT,
  UNRECOGNISED,
  VERDICT_CHIP_LABEL,
  VERDICT_SEVERITY,
  VERDICTS,
  worstVerdictOf,
  type DiagnosticBlock,
  type DiagnosticRow,
  type SectionTaggedOutcome,
} from './diagnosticsSections'
import { TONES } from './syncDiagnostics'

/**
 * The contract every diagnostics section is built on, tested as a contract: not
 * "does this helper format a string", but "can a section express a claim it has
 * not earned". Each block below pins one of the three mechanisms the module
 * header describes.
 */

/** The environment values a leak would carry, planted into every field that takes one. */
const SECRETS = [
  'redis://admin:hunter2@redis.internal.example:6379',
  'syncing.internal.example:50051',
  'super-secret-jwt-signing-key',
  'hunter2',
  'internal.example',
]

describe('SafeValue constructors — presence, never values', () => {
  it('admits a literal from this build and returns it unchanged', () => {
    expect(safeConstant('attached')).toBe('attached')
  })

  it('does not compile when handed a value of type string', () => {
    const fromTheWire: string = SECRETS[0]

    // @ts-expect-error a `string` is exactly what a server field is; only a literal is admissible
    const refused = safeConstant(fromTheWire)

    // The runtime behaviour is irrelevant — the assertion above is the compile-time
    // one, and ts-jest evaluates it. This keeps the variable used.
    expect(typeof refused).toBe('string')
  })

  it.each<[boolean | undefined, string]>([
    [true, 'yes'],
    [false, 'no'],
    [undefined, 'not reported'],
  ])('safeYesNo(%s) is %s — absent is not false', (input, expected) => {
    expect(safeYesNo(input)).toBe(expected)
  })

  it.each<[boolean | undefined, string]>([
    [true, 'set'],
    [false, 'not set'],
    [undefined, 'not reported'],
  ])('safePresence(%s) is %s', (input, expected) => {
    expect(safePresence(input)).toBe(expected)
  })

  it.each<[boolean | undefined, string]>([
    [true, 'attached'],
    [false, 'not attached'],
    [undefined, 'not reported'],
  ])('safeState(%s) uses the row own words, and neither of them when absent', (input, expected) => {
    expect(safeState(input, 'attached', 'not attached')).toBe(expected)
  })

  it('admits a declared enum member', () => {
    expect(safeEnum('grpc', ['grpc', 'http', 'direct-call'])).toBe('grpc')
  })

  it.each(SECRETS)('collapses %s to a constant instead of echoing it', (secret) => {
    const value = safeEnum(secret, ['grpc', 'http', 'direct-call'])

    expect(value).toBe(UNRECOGNISED)
    expect(value).not.toContain(secret)
  })

  it.each<[unknown, string]>([
    [undefined, 'not reported'],
    [null, 'not reported'],
  ])('safeEnum(%s) is not reported rather than unrecognised', (input, expected) => {
    expect(safeEnum(input, ['grpc'])).toBe(expected)
  })

  it('refuses a non-string even when it is truthy', () => {
    expect(safeEnum({ toString: () => 'grpc' }, ['grpc'])).toBe(UNRECOGNISED)
  })

  it.each<[number, string]>([
    [0, '0'],
    [7, '7'],
    [1024, '1024'],
  ])('safeCount(%s) is %s', (input, expected) => {
    expect(safeCount(input)).toBe(expected)
  })

  it.each<[number | undefined, string]>([
    [-1, 'a negative count'],
    [1.5, 'a non-integer'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [undefined, 'absent'],
  ])('safeCount refuses %s (%s)', (input) => {
    expect(safeCount(input)).toBe('not reported')
  })

  it.each<[number, string]>([
    [0, 'under 1s'],
    [0.4, 'under 1s'],
    [1, '1s'],
    [59, '59s'],
    [60, '1m 0s'],
    [3599, '59m 59s'],
    [3600, '1h 0m'],
    [86399, '23h 59m'],
    [86400, '1d 0h'],
    [90061, '1d 1h'],
  ])('safeDuration(%s) is %s', (input, expected) => {
    expect(safeDuration(input)).toBe(expected)
  })

  it.each<[number | undefined]>([[-1], [Number.NaN], [undefined]])('safeDuration refuses %s', (input) => {
    expect(safeDuration(input)).toBe('not reported')
  })

  it.each<[number, string]>([
    [0, '0-25%'],
    [0.249, '0-25%'],
    [0.25, '25-50%'],
    [0.5, '50-75%'],
    [0.75, '75-90%'],
    [0.9, '90-100%'],
    [1, '90-100%'],
    [1.2, 'over 100%'],
  ])('safePercentBucket(%s) is %s', (input, expected) => {
    expect(safePercentBucket(input)).toBe(expected)
  })

  it('only ever returns a declared bucket or the not-reported constant', () => {
    const outputs = [-1, 0, 0.3, 0.6, 0.8, 0.95, 1, 4, Number.NaN, undefined].map((input) =>
      String(safePercentBucket(input)),
    )

    for (const output of outputs) {
      expect([...PERCENT_BUCKETS, 'not reported']).toContain(output)
    }
  })

  it('admits an environment variable name by shape', () => {
    expect(safeEnvName('WEBSOCKET_REDIS_NAMESPACE')).toBe('WEBSOCKET_REDIS_NAMESPACE')
  })

  it.each(SECRETS)('refuses %s as a variable name rather than repairing it', (secret) => {
    const value = safeEnvName(secret)

    expect(value).toBe('withheld (unrecognised format)')
    expect(value).not.toContain(secret)
  })

  it('refuses a lower-case or punctuated name, and reports a non-string as absent', () => {
    expect(safeEnvName('redis_url')).toBe('withheld (unrecognised format)')
    expect(safeEnvName('A'.repeat(65))).toBe('withheld (unrecognised format)')
    expect(safeEnvName(undefined)).toBe('not reported')
    expect(ENV_NAME.test('MODE')).toBe(true)
  })

  it('joins already-safe parts and builds a report line', () => {
    expect(safeTokens(safeConstant('redis'), safeConstant('(ready)'))).toBe('redis (ready)')
    expect(reportLine(safeConstant('Gateway'), safeYesNo(true))).toBe('- Gateway: yes')
  })
})

/**
 * The mechanism this whole task exists for.
 *
 * The pane renders "SYNC_ITEMS Advertised" from `container.isBound(...)` while the
 * handshake advertises on `backend.ready()`, which additionally needs a usable
 * >=32-byte internal secret. The chip was not wrong about its input; it was wrong
 * about what its input ESTABLISHED. These cases are that defect, expressed in the
 * contract rather than in one section.
 */
describe('Evidence — a row may not claim more than its source establishes', () => {
  const PROXY = evidenceProxy({
    observed: 'that the gRPC syncing proxy was bound at boot',
    cannotConfirm: 'that the handshake advertises SYNC_ITEMS',
    necessaryCondition: true,
  })

  it('passes a healthy verdict through when the evidence is direct', () => {
    const row = diagnosticRow({
      label: safeConstant('SYNC_ITEMS'),
      value: safeState(true, 'advertised', 'withheld'),
      verdict: 'healthy',
      evidence: EVIDENCE_DIRECT,
      note: 'The handshake itself reported the operation.',
    })

    expect(row.verdict).toBe('healthy')
    expect(row.tone).toBe('good')
    expect(row.caveat).toBeUndefined()
  })

  it('caps a healthy verdict built on a proxy to undetermined, and says why', () => {
    const row = diagnosticRow({
      label: safeConstant('SYNC_ITEMS'),
      value: safeState(true, 'advertised', 'withheld'),
      verdict: 'healthy',
      evidence: PROXY,
      note: 'Derived from the boot gate rather than from the handshake.',
    })

    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.tone).toBe('neutral')
    expect(row.caveat).toContain('does not establish')
    expect(row.caveat).toContain('that the handshake advertises SYNC_ITEMS')
  })

  it('caps a degraded verdict too — partly working is still a claim about the thing', () => {
    const row = diagnosticRow({
      label: safeConstant('SYNC_ITEMS'),
      value: safeConstant('partial'),
      verdict: 'degraded',
      evidence: PROXY,
      note: 'note',
    })

    expect(row.verdict).toBe('undetermined')
  })

  it('lets a broken verdict stand on a NECESSARY condition that failed', () => {
    const row = diagnosticRow({
      label: safeConstant('SYNC_ITEMS'),
      value: safeState(false, 'advertised', 'withheld'),
      verdict: 'broken',
      evidence: PROXY,
      note: 'The proxy was never bound, so the handshake cannot advertise it.',
    })

    expect(row.verdict).toBe('broken')
    expect(row.tone).toBe('bad')
    expect(row.caveat).toContain('Indirect')
  })

  it('refuses a broken verdict built on a merely correlated signal', () => {
    const row = diagnosticRow({
      label: safeConstant('SYNC_ITEMS'),
      value: safeConstant('withheld'),
      verdict: 'broken',
      evidence: evidenceProxy({
        observed: 'that no push bridge is bound',
        cannotConfirm: 'that SYNC_ITEMS is withheld',
        necessaryCondition: false,
      }),
      note: 'note',
    })

    expect(row.verdict).toBe('undetermined')
    expect(row.caveat).toContain('does not establish')
  })

  it.each([...VERDICTS])('collapses a %s verdict to undetermined when nothing was reported', (verdict) => {
    const row = diagnosticRow({
      label: safeConstant('Gateway'),
      value: safeYesNo(undefined),
      verdict,
      evidence: EVIDENCE_ABSENT,
      note: 'note',
    })

    expect(row.verdict).toBe('undetermined')
    expect(row.tone).toBe('neutral')
  })

  it('does not nag about a cap that changed nothing', () => {
    const row = diagnosticRow({
      label: safeConstant('Gateway'),
      value: safeYesNo(undefined),
      verdict: 'undetermined',
      evidence: EVIDENCE_ABSENT,
      note: 'note',
    })

    expect(row.caveat).toBeUndefined()
  })

  /**
   * The capping is only worth anything if it cannot be gone round, so these two
   * are compile-time assertions rather than runtime ones. `@ts-expect-error`
   * FAILS the suite when the expression it guards starts compiling, which is what
   * makes them live rather than decorative.
   */
  it('cannot be satisfied by a hand-written row that states its own tone', () => {
    const rows: DiagnosticRow[] = [
      // @ts-expect-error a row must come from diagnosticRow(), which is what derives tone from evidence
      {
        label: safeConstant('SYNC_ITEMS'),
        value: safeConstant('advertised'),
        claimed: 'healthy',
        verdict: 'healthy',
        tone: 'good',
        evidence: PROXY,
        note: 'note',
      },
    ]

    expect(rows).toHaveLength(1)
  })

  it('rejects a plain string where a label or a value is required', () => {
    const row = diagnosticRow({
      // @ts-expect-error a bare string is indistinguishable from a server-supplied one
      label: 'Gateway',
      value: safeConstant('attached'),
      verdict: 'healthy',
      evidence: EVIDENCE_DIRECT,
      note: 'note',
    })

    expect(row.label).toBe('Gateway')
  })

  it('applies the same capping to a finding', () => {
    const finding = diagnosticFinding({
      code: safeConstant('SYNC_ITEMS_ADVERTISEMENT_UNCONFIRMED'),
      title: 'SYNC_ITEMS may be withheld',
      detail: 'detail',
      verdict: 'healthy',
      evidence: PROXY,
    })

    expect(finding.verdict).toBe('undetermined')
    expect(finding.tone).toBe('neutral')
    expect(finding.caveat).toContain('does not establish')
  })
})

describe('Verdict and tone mappings are exhaustive, not ternary chains', () => {
  it('maps every declared verdict to a tone and a chip label', () => {
    for (const verdict of VERDICTS) {
      expect(TONE_FOR_VERDICT[verdict]).toBeDefined()
      expect(TONES).toContain(TONE_FOR_VERDICT[verdict])
      expect(VERDICT_CHIP_LABEL[verdict]).toBeTruthy()
      expect(VERDICT_SEVERITY[verdict]).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps "could not determine" distinct from "unavailable" at the label, not just the tone', () => {
    expect(TONE_FOR_VERDICT.undetermined).toBe('neutral')
    expect(TONE_FOR_VERDICT.informational).toBe('neutral')
    expect(VERDICT_CHIP_LABEL.undetermined).not.toBe(VERDICT_CHIP_LABEL.broken)
    expect(VERDICT_CHIP_LABEL.undetermined).not.toBe(VERDICT_CHIP_LABEL.informational)
    expect(new Set(Object.values(VERDICT_CHIP_LABEL)).size).toBe(VERDICTS.length)
  })

  it('ranks an undetermined section above a healthy one and below a degraded one', () => {
    expect(VERDICT_SEVERITY.undetermined).toBeGreaterThan(VERDICT_SEVERITY.healthy)
    expect(VERDICT_SEVERITY.undetermined).toBeLessThan(VERDICT_SEVERITY.degraded)
    expect(VERDICT_SEVERITY.broken).toBeGreaterThan(VERDICT_SEVERITY.degraded)
  })

  it('names every section exactly once, and only the five topic sections', () => {
    expect(SECTION_IDS).toHaveLength(5)
    const titles = SECTION_IDS.map((id) => String(SECTION_TITLE[id]))
    expect(new Set(titles).size).toBe(SECTION_IDS.length)
    for (const title of titles) {
      expect(title.length).toBeGreaterThan(0)
    }
    expect(titles).not.toContain('Overview')
    expect(titles).not.toContain('Checks')
  })

  it('declares the lane rejection statuses as a closed tuple', () => {
    expect([...LANE_REJECTION_STATUSES]).toEqual([401, 498])
  })
})

describe('worstVerdictOf and blockWorstVerdict', () => {
  it('treats an empty list as undetermined, not as healthy', () => {
    expect(worstVerdictOf([])).toBe('undetermined')
  })

  it('picks the worst regardless of order', () => {
    expect(worstVerdictOf(['healthy', 'broken', 'degraded'])).toBe('broken')
    expect(worstVerdictOf(['broken', 'healthy'])).toBe('broken')
    expect(worstVerdictOf(['informational', 'healthy'])).toBe('healthy')
    expect(worstVerdictOf(['healthy', 'undetermined'])).toBe('undetermined')
  })

  it('reads a block worst verdict from its rows AND its findings', () => {
    const block: DiagnosticBlock = {
      heading: safeConstant('Lane and boot gate'),
      description: 'description',
      rows: [
        diagnosticRow({
          label: safeConstant('Lane'),
          value: safeState(true, 'up', 'down'),
          verdict: 'healthy',
          evidence: EVIDENCE_DIRECT,
          note: 'note',
        }),
      ],
      findings: [
        diagnosticFinding({
          code: safeConstant('LANE_FLAPPING'),
          title: 'title',
          detail: 'detail',
          verdict: 'degraded',
          evidence: EVIDENCE_DIRECT,
        }),
      ],
    }

    expect(blockWorstVerdict(block)).toBe('degraded')
    expect(isBlockEmpty(block)).toBe(false)
  })

  it('counts a block carrying only probe outcomes as non-empty', () => {
    const outcome: SectionTaggedOutcome = {
      name: 'Ticket mint',
      passed: true,
      detail: 'detail',
      reportDetail: 'reportDetail',
      section: 'websocket',
    }

    expect(
      isBlockEmpty({
        heading: safeConstant('Socket checks'),
        description: 'description',
        rows: [],
        findings: [],
        outcomes: [outcome],
      }),
    ).toBe(false)
  })
})

describe('outcomesForSection', () => {
  const outcomes: SectionTaggedOutcome[] = [
    { name: 'a', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' },
    { name: 'b', passed: false, detail: 'd', reportDetail: 'r', section: 'browser' },
    { name: 'c', passed: true, detail: 'd', reportDetail: 'r' },
  ]

  it('keeps only the outcomes tagged for that section, and drops untagged ones', () => {
    expect(outcomesForSection(outcomes, 'websocket').map((outcome) => outcome.name)).toEqual(['a'])
    expect(outcomesForSection(outcomes, 'environment')).toHaveLength(0)
  })
})

describe('buildSectionModel', () => {
  const healthyRow = () =>
    diagnosticRow({
      label: safeConstant('Gateway'),
      value: safeState(true, 'attached', 'not attached'),
      verdict: 'healthy',
      evidence: EVIDENCE_DIRECT,
      note: 'A websocket gateway is attached to this process.',
    })

  const brokenFinding = () =>
    diagnosticFinding({
      code: safeConstant('PUSH_BRIDGE_UNBOUND'),
      title: 'Nothing carries change notifications',
      detail: 'detail',
      verdict: 'broken',
      evidence: EVIDENCE_DIRECT,
    })

  it('takes its title from the one exhaustive mapping', () => {
    const model = buildSectionModel({ id: 'backend', blocks: [] })

    expect(model.title).toBe(SECTION_TITLE.backend)
    expect(model.id).toBe('backend')
  })

  it('derives the worst verdict and tone across every block', () => {
    const model = buildSectionModel({
      id: 'websocket',
      blocks: [
        { heading: safeConstant('Lane'), description: 'd', rows: [healthyRow()], findings: [] },
        { heading: safeConstant('Realtime health'), description: 'd', rows: [], findings: [brokenFinding()] },
      ],
    })

    expect(model.worstVerdict).toBe('broken')
    expect(model.worst).toBe('bad')
  })

  it('reports an empty section as undetermined rather than healthy', () => {
    const model = buildSectionModel({ id: 'browser', blocks: [] })

    expect(model.worstVerdict).toBe('undetermined')
    expect(model.worst).toBe('neutral')
    expect(model.headline).toBeUndefined()
  })

  it('exposes the single worst finding for the Overview router', () => {
    const model = buildSectionModel({
      id: 'account',
      blocks: [
        {
          heading: safeConstant('Requirements'),
          description: 'd',
          rows: [],
          findings: [
            diagnosticFinding({
              code: safeConstant('STORAGE_NEARLY_FULL'),
              title: 'Storage nearly full',
              detail: 'detail',
              verdict: 'degraded',
              evidence: EVIDENCE_DIRECT,
            }),
            brokenFinding(),
          ],
        },
      ],
    })

    expect(model.headline?.code).toBe('PUSH_BRIDGE_UNBOUND')
  })

  it('builds report lines from the safe halves of each row, and from finding CODES only', () => {
    const model = buildSectionModel({
      id: 'websocket',
      blocks: [{ heading: safeConstant('Lane'), description: 'd', rows: [healthyRow()], findings: [brokenFinding()] }],
      extraReportLines: [reportLine(safeConstant('Protocol version'), safeCount(1))],
    })
    const report = model.reportLines.join('\n')

    expect(report).toContain('## WebSocket')
    expect(report).toContain('- Worst verdict: broken')
    expect(report).toContain('### Lane')
    expect(report).toContain('- Gateway: attached')
    expect(report).toContain('- Finding: PUSH_BRIDGE_UNBOUND broken')
    expect(report).toContain('- Protocol version: 1')
    // Prose stays on screen. `note`, `title` and `detail` are the three fields a
    // builder could interpolate a server value into, so none of them is on the
    // path to a report that is written to be pasted in public.
    expect(report).not.toContain('A websocket gateway is attached to this process.')
    expect(report).not.toContain('Nothing carries change notifications')
  })

  it('says so in the report when a block carried nothing', () => {
    const model = buildSectionModel({
      id: 'environment',
      blocks: [{ heading: safeConstant('Service proxy decision'), description: 'd', rows: [], findings: [] }],
    })

    expect(model.reportLines.join('\n')).toContain('Nothing was reported for this block.')
  })

  it('cannot be made to carry a planted secret through any field it reports', () => {
    const model = buildSectionModel({
      id: 'environment',
      blocks: [
        {
          heading: safeConstant('Topology'),
          description: SECRETS[0],
          rows: [
            diagnosticRow({
              label: safeEnvName(SECRETS[1]),
              value: safeEnum(SECRETS[2], ['grpc', 'http']),
              verdict: 'broken',
              evidence: EVIDENCE_DIRECT,
              note: SECRETS[3],
            }),
          ],
          findings: [
            diagnosticFinding({
              code: safeConstant('SERVICE_PROXY_NOT_GRPC'),
              title: SECRETS[4],
              detail: SECRETS[0],
              verdict: 'broken',
              evidence: EVIDENCE_DIRECT,
            }),
          ],
        },
      ],
    })
    const report = model.reportLines.join('\n')

    for (const secret of SECRETS) {
      expect(report).not.toContain(secret)
    }
  })
})

/**
 * The brand on `SafeValue` is nominal, not cryptographic: `x as SafeValue`
 * compiles. That is accepted in the module header on one condition — that every
 * deliberate bypass is a single greppable expression — and this is what collects
 * on the condition.
 *
 * It is VACUOUS until the first section module lands, and that is the honest
 * state of it rather than a hidden one: the assertion on this module's own
 * presence exists so that a renamed directory or a typo'd path fails loudly
 * instead of turning the scan into a gate nobody runs.
 */
describe('no section module bypasses the SafeValue brand', () => {
  const directory = __dirname

  it('can see the module it is guarding', () => {
    expect(readFileSync(join(directory, 'diagnosticsSections.ts'), 'utf8')).toContain('export type SafeValue')
  })

  it('finds no `as SafeValue` in any section module', () => {
    const modules = readdirSync(directory).filter((name) => /Section\.ts$/.test(name) && !name.includes('.spec.'))

    for (const name of modules) {
      // `as unknown as SafeValue` contains this substring too, so one check
      // covers both spellings of the bypass.
      expect(readFileSync(join(directory, name), 'utf8')).not.toContain('as SafeValue')
    }
  })
})
