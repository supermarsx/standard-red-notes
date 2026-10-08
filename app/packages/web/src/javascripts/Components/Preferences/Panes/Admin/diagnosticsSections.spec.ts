import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  blockWorstVerdict,
  buildSectionModel,
  describeCensus,
  diagnosticFinding,
  diagnosticRow,
  ENV_NAME,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  isBlockEmpty,
  LANE_REJECTION_STATUSES,
  NOT_PUBLISHED,
  outcomesForSection,
  PERCENT_BUCKETS,
  PROXY_RELATIONS,
  readingCensus,
  readingOf,
  READING_MARKER,
  READING_MEANING,
  READING_TAG,
  reportLine,
  reportRow,
  ROW_READINGS,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safeEnvName,
  safePercentBucket,
  safePresence,
  safeState,
  safeToken,
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
  type Evidence,
  type SafeValue,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import { admitToken, declarePattern, DEPLOY_REVISION, VERSION_TOKEN } from './reportAllowlist'
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
 * `safeToken` — the category a 40-character git revision belongs to.
 *
 * It is `reportAllowlist.ts`'s `admitToken` plus the brand, deliberately NOT a
 * second admission rule: the two copyable reports have been admitting a revision
 * by shape since before this contract existed, and a row that admitted it by its
 * own slightly different rule is how a value comes to be printed in one place and
 * withheld in another.
 */
describe('safeToken — admission by a shape this build declared', () => {
  const REVISION = 'a9f3c0deadbeef0123456789abcdef0123456789'

  it('is the same rule as the reports use, not a copy of it', () => {
    expect(safeToken(REVISION, DEPLOY_REVISION)).toBe(REVISION)
    expect(safeToken(REVISION, DEPLOY_REVISION)).toBe(admitToken(REVISION, DEPLOY_REVISION))
    expect(safeToken('nope', DEPLOY_REVISION)).toBe(admitToken('nope', DEPLOY_REVISION))
  })

  it('reports a non-string as absent rather than as a rejected value', () => {
    expect(safeToken(undefined, DEPLOY_REVISION)).toBe('not reported')
    expect(safeToken(null, DEPLOY_REVISION)).toBe('not reported')
    expect(safeToken(42, DEPLOY_REVISION)).toBe('not reported')
    // A non-string that stringifies to a match is still not a string.
    expect(safeToken({ toString: () => REVISION }, DEPLOY_REVISION)).toBe('not reported')
  })

  /**
   * *** THE PROPERTY THE WHOLE CONSTRUCTOR EXISTS FOR ***
   *
   * A rejected token is replaced by a CONSTANT. It is not truncated, not partially
   * scrubbed, and not quoted back in the withheld marker — the health report's own
   * scan caught a revision reading `token-sk-live-…` printed verbatim, and a
   * version printed as `v1.2.3-build@[address withheld]` with the host removed and
   * the rest intact. Each candidate is asserted on its own, because an assertion
   * over a set is satisfied by any member of it.
   */
  it.each([
    'syncing-server:50051',
    'https://sync.internal.example.com/v1/items',
    'postgres://srn:hunter2@db.internal.example:5432/srn',
    'sk-live-0123456789abcdef0123456789abcdef',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c0ffee',
    `prefix-${'a'.repeat(40)}`,
    `${'a'.repeat(40)}-suffix`,
    'A9F3C0DEADBEEF0123456789ABCDEF0123456789',
  ])('withholds %s without echoing any of it', (unsafe) => {
    const value = safeToken(unsafe, DEPLOY_REVISION)

    expect(value).toBe('withheld (unrecognised format)')
    expect(value).not.toContain(unsafe)
    // Nor any recognisable fragment of it: the marker is a constant, so the only
    // way a fragment could appear is a partial scrub.
    for (const fragment of unsafe.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 3)) {
      expect(value).not.toContain(fragment)
    }
  })

  it.each(SECRETS)('withholds the planted value %s', (secret) => {
    expect(safeToken(secret, DEPLOY_REVISION)).toBe('withheld (unrecognised format)')
    expect(safeToken(secret, DEPLOY_REVISION)).not.toContain(secret)
  })

  it('cannot be handed a pattern derived from the data it is admitting', () => {
    const fromTheWire: string = `^${SECRETS[0]}$`

    // @ts-expect-error a shape must be a literal of this build; a server string is not one
    const circular = declarePattern(fromTheWire)

    // The assertion above is the compile-time one, and ts-jest evaluates it. The
    // value is kept used to show exactly what the type rule prevents: a shape
    // derived from server data admits the very value that supplied it, so the
    // allowlist would be an echo with extra steps.
    expect(circular.test(SECRETS[0])).toBe(true)
    expect(safeToken(SECRETS[0], circular)).toBe(SECRETS[0])
  })

  /**
   * An unanchored shape matches a SUBSTRING, so `[0-9a-f]{40}` would admit a whole
   * connection string with a hex blob inside it. That is the exact leak the
   * allowlist exists to stop, so it is refused at declaration time rather than
   * left to each caller to remember.
   */
  it('refuses an unanchored shape at declaration time', () => {
    expect(() => declarePattern('[0-9a-f]{40}')).toThrow('anchored')
    expect(() => declarePattern('^[0-9a-f]{40}')).toThrow('anchored')
    expect(() => declarePattern('[0-9a-f]{40}$')).toThrow('anchored')
    expect(() => declarePattern('^[0-9a-f]{40}$')).not.toThrow()

    // And the refusal is not cosmetic: the unanchored shape really would have
    // admitted a connection string whole.
    expect(new RegExp('[0-9a-f]{40}').test(`redis://x:${'a'.repeat(40)}@cache:6379`)).toBe(true)
    expect(DEPLOY_REVISION.test(`redis://x:${'a'.repeat(40)}@cache:6379`)).toBe(false)
  })

  it('carries no flags, so testing the same value twice cannot answer differently', () => {
    expect(DEPLOY_REVISION.flags).toBe('')
    expect(safeToken(REVISION, DEPLOY_REVISION)).toBe(REVISION)
    expect(safeToken(REVISION, DEPLOY_REVISION)).toBe(REVISION)
  })

  it('still admits the shapes the reports already depended on', () => {
    expect(DEPLOY_REVISION.test(REVISION)).toBe(true)
    expect(VERSION_TOKEN.test('1.2.3-beta+build.4')).toBe(true)
    expect(VERSION_TOKEN.test('-leading-dash')).toBe(false)
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

  /* ------------------------------------------------------------------------ */
  /* The caveat is a claim too                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * The defect these pin, which shipped latent in the first version of the
   * contract.
   *
   * Nothing caps an `informational` or an `undetermined` claim — there is nothing
   * stronger for either to be reduced to — so `verdict === claimed`, so the
   * UNCAPPED caveat branch ran, and that branch printed one sentence for every
   * proxy: "a condition X requires. Its failure is conclusive." That is true of a
   * necessary condition and false of a correlated one, so a row whose author had
   * explicitly written `necessaryCondition: false` got a sentence asserting a
   * logical relationship nobody declared. The verdict was right and the caveat
   * beside it overstated, which is this module's own defect one level down.
   *
   * `browserSection.ts` happens to mark every one of its proxies
   * `necessaryCondition: true`, so nothing on screen was wrong — these cases exist
   * so that the next section to write the natural thing is not the one that finds
   * out.
   */
  const CORRELATED = evidenceProxy({
    observed: 'that a Redis push bridge is attached',
    cannotConfirm: 'that this client receives pushes',
    necessaryCondition: false,
  })

  it.each<Verdict>(['informational', 'undetermined'])(
    'does not call a correlated signal conclusive on an uncapped %s claim',
    (verdict) => {
      const row = diagnosticRow({
        label: safeConstant('Push bridge'),
        value: safeState(true, 'attached', 'not attached'),
        verdict,
        evidence: CORRELATED,
        note: 'note',
      })

      expect(row.claimed).toBe(verdict)
      expect(row.verdict).toBe(verdict)
      expect(row.caveat).toBeDefined()
      expect(row.caveat).not.toContain('conclusive')
      expect(row.caveat).toContain('without being required by it')
      expect(row.caveat).toContain('Neither its success nor its failure establishes')
    },
  )

  it('does call a NECESSARY condition conclusive, which is the one relation that is', () => {
    const row = diagnosticRow({
      label: safeConstant('Push bridge'),
      value: safeState(true, 'attached', 'not attached'),
      verdict: 'informational',
      evidence: PROXY,
      note: 'note',
    })

    expect(row.verdict).toBe('informational')
    expect(row.caveat).toContain('Its failure is conclusive')
  })

  /**
   * The invariant itself, over the whole matrix rather than over the cases
   * somebody thought of. A caveat may assert conclusiveness only where the
   * evidence declared a necessary condition — on any verdict, on a row or on a
   * finding.
   */
  it.each<[string, Evidence, boolean]>([
    ['direct evidence', EVIDENCE_DIRECT, false],
    ['absent evidence', EVIDENCE_ABSENT, false],
    ['a correlated proxy', CORRELATED, false],
    ['a necessary-condition proxy', PROXY, true],
  ])('only lets %s claim conclusiveness when it has it', (_name, evidence, mayClaimConclusive) => {
    for (const verdict of VERDICTS) {
      const row = diagnosticRow({
        label: safeConstant('Push bridge'),
        value: safeConstant('attached'),
        verdict,
        evidence,
        note: 'note',
      })
      const finding = diagnosticFinding({
        code: safeConstant('PUSH_BRIDGE_UNCONFIRMED'),
        title: 'title',
        detail: 'detail',
        verdict,
        evidence,
      })

      for (const caveat of [row.caveat ?? '', finding.caveat ?? '']) {
        if (!mayClaimConclusive) {
          expect(caveat).not.toContain('conclusive')
        }
      }

      expect(row.caveat).toBe(finding.caveat)
    }
  })

  it('writes one caveat sentence per declared proxy relation, and no two alike', () => {
    const sentences = PROXY_RELATIONS.map(
      (relation) =>
        diagnosticRow({
          label: safeConstant('Push bridge'),
          value: safeConstant('attached'),
          verdict: 'informational',
          evidence: evidenceProxy({
            observed: 'that a Redis push bridge is attached',
            cannotConfirm: 'that this client receives pushes',
            necessaryCondition: relation === 'necessary',
          }),
          note: 'note',
        }).caveat,
    )

    for (const sentence of sentences) {
      expect(sentence).toBeTruthy()
    }
    expect(new Set(sentences).size).toBe(PROXY_RELATIONS.length)
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
    expect(report).toContain('- [v] Gateway: attached')
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
 * It was VACUOUS while no section module existed, which was then the honest state
 * of it. Section modules now exist, so the scan's CORPUS is asserted too: a scan
 * over zero files passes for the same reason a scan over clean files does, and
 * "every section module" is only a guarantee if the list is known to contain the
 * sections. A renamed file, a moved directory or a `.tsx` section would otherwise
 * drop silently out of the corpus and leave this reading green.
 */
/**
 * *** THE THREE SILENCES, AS A CLOSED VALUE. ***
 *
 * "We asked and got a value", "we asked and got nothing" and "nothing publishes
 * this" are three different facts. The pane already modelled all three carefully
 * and then printed them as two sentences a reader had to parse — on a realistic
 * deployment, 49 of 239 report rows read exactly `not reported` with nothing in
 * the line saying which silence it was or why.
 *
 * The derivation is from the row's own already-safe VALUE, which is why these
 * tests drive it through the constructors rather than by passing strings: a
 * reading stored separately from the value is a reading that can disagree with
 * what the row prints.
 */
describe('readingOf', () => {
  it('reads a value as answered', () => {
    expect(readingOf(safeYesNo(true))).toBe('answered')
    expect(readingOf(safeYesNo(false))).toBe('answered')
    expect(readingOf(safeCount(0))).toBe('answered')
    expect(readingOf(safeState(true, 'attached', 'not attached'))).toBe('answered')
  })

  it('reads an absent field as asked-and-nothing-came-back', () => {
    expect(readingOf(safeYesNo(undefined))).toBe('unanswered')
    expect(readingOf(safeCount(undefined))).toBe('unanswered')
    expect(readingOf(safePresence(undefined))).toBe('unanswered')
    expect(readingOf(safeEnum(undefined, ['a']))).toBe('unanswered')
    expect(readingOf(safeDuration(undefined))).toBe('unanswered')
  })

  it('reads a field with no producer as its own third state', () => {
    expect(readingOf(NOT_PUBLISHED)).toBe('unpublished')
    expect(readingOf(NOT_PUBLISHED)).not.toBe('unanswered')
  })

  /**
   * *** A REFUSED VALUE IS A READING, NOT A SILENCE. *** The server answered and
   * the answer was refused on the way out. Counting it as a silence would report a
   * misbehaving server as a quiet one, which is the flattering direction.
   */
  it('reads a refused or unrecognised value as answered', () => {
    expect(readingOf(safeEnum('redis://admin:hunter2@host:6379', ['grpc']))).toBe('answered')
    expect(readingOf(safeEnvName('not a variable name'))).toBe('answered')
    expect(readingOf(safeToken('nope', DEPLOY_REVISION))).toBe('answered')
  })

  /**
   * *** MATCHED BY PREFIX, ANCHORED AT THE START. *** Several real rows join a
   * qualifier to a sentinel, and at least one real row CONTAINS the words "not
   * reported" inside a value that is itself a reading — the internal-secret row's
   * `not set (threshold not established: no lane decision reported)`. A substring
   * match would call that a silence.
   */
  it('does not call a value a silence because it mentions one', () => {
    expect(readingOf(safeTokens(safePresence(false), safeConstant('(threshold not reported)')))).toBe('answered')
    expect(readingOf(safeTokens(safeConstant('no endpoint publishes this'), safeConstant('(yet)')))).toBe('unpublished')
    expect(readingOf(safeTokens(safeConstant('not reported'), safeConstant('(by this build)')))).toBe('unanswered')
  })
})

describe('readingCensus and describeCensus', () => {
  const rowsOf = (...values: SafeValue[]) =>
    values.map((value, index) =>
      diagnosticRow({
        label: safeConstant(`Row ${index}` as 'Row'),
        value,
        verdict: 'informational',
        evidence: EVIDENCE_DIRECT,
        note: 'n',
      }),
    )

  it('always carries all three keys, so a zero is a reading', () => {
    const census = readingCensus(rowsOf(safeYesNo(true)))

    expect(census).toEqual({ answered: 1, unanswered: 0, unpublished: 0 })
  })

  it('counts a mixed block correctly', () => {
    const census = readingCensus(rowsOf(safeYesNo(true), safeCount(undefined), safeCount(undefined), NOT_PUBLISHED))

    expect(census).toEqual({ answered: 1, unanswered: 2, unpublished: 1 })
  })

  /**
   * The per-block census omits readings at zero — it is read beside the rows
   * themselves, where an absent group is visible. The REPORT's census names all
   * three, zeros included, because nobody reading a paste can see what is absent.
   */
  it('names only the readings present, and says so when there are no rows', () => {
    expect(describeCensus(readingCensus(rowsOf(safeYesNo(true))))).toBe('1 answered')
    expect(describeCensus(readingCensus(rowsOf(safeYesNo(true), safeCount(undefined))))).toBe(
      '1 answered · 1 no answer',
    )
    expect(describeCensus(readingCensus([]))).toBe('no rows')
  })
})

describe('reportRow', () => {
  const row = (value: SafeValue) =>
    diagnosticRow({
      label: safeConstant('Ticket minting right now'),
      value,
      verdict: 'informational',
      evidence: EVIDENCE_DIRECT,
      note: 'n',
    })

  it('marks each of the three readings with its own marker', () => {
    expect(String(reportRow(row(safeState(true, 'issuing', 'refusing'))))).toBe(
      '- [v] Ticket minting right now: issuing',
    )
    expect(String(reportRow(row(safeCount(undefined))))).toBe('- [?] Ticket minting right now: not reported')
    expect(String(reportRow(row(NOT_PUBLISHED)))).toBe('- [n] Ticket minting right now: no endpoint publishes this')
  })

  it('draws every marker from the exhaustive Record, and uses three distinct ones', () => {
    expect(Object.keys(READING_MARKER).sort()).toEqual([...ROW_READINGS].sort())
    expect(new Set(Object.values(READING_MARKER)).size).toBe(ROW_READINGS.length)
    for (const reading of ROW_READINGS) {
      expect(READING_MARKER[reading].length).toBeGreaterThan(0)
      expect(READING_TAG[reading].length).toBeGreaterThan(0)
      expect(READING_MEANING[reading].length).toBeGreaterThan(0)
    }
    expect(new Set(Object.values(READING_TAG)).size).toBe(ROW_READINGS.length)
  })

  /**
   * A hand-written report line is a statement ABOUT the section, not a reading of
   * a field, so it has no reading to mark. Keeping the two constructors apart is
   * what makes the marker column mean exactly one thing.
   */
  it('leaves a hand-written extra line unmarked', () => {
    expect(String(reportLine(safeConstant('Allowed origin list'), safeConstant('never collected')))).toBe(
      '- Allowed origin list: never collected',
    )
  })
})

describe('buildSectionModel — the row census in the report', () => {
  const model = (values: SafeValue[]) =>
    buildSectionModel({
      id: 'websocket',
      blocks: [
        {
          heading: safeConstant('Lane'),
          description: 'd',
          rows: values.map((value, index) =>
            diagnosticRow({
              label: safeConstant(`Row ${index}` as 'Row'),
              value,
              verdict: 'informational',
              evidence: EVIDENCE_DIRECT,
              note: 'n',
            }),
          ),
          findings: [],
        },
      ],
    })

  it('states how many rows the section produced and what they were', () => {
    const report = model([safeYesNo(true), safeCount(undefined), NOT_PUBLISHED]).reportLines.join('\n')

    expect(report).toContain('- Rows: 3 (1 answered · 1 no answer · 1 no source)')
  })

  /**
   * Counted across EVERY block, not per block: the line sits beside the section's
   * worst verdict and answers "how much of this section is a reading".
   */
  it('counts across every block in the section', () => {
    const across = buildSectionModel({
      id: 'browser',
      blocks: [
        {
          heading: safeConstant('One'),
          description: 'd',
          rows: [
            diagnosticRow({
              label: safeConstant('A'),
              value: safeYesNo(true),
              verdict: 'healthy',
              evidence: EVIDENCE_DIRECT,
              note: 'n',
            }),
          ],
          findings: [],
        },
        {
          heading: safeConstant('Two'),
          description: 'd',
          rows: [
            diagnosticRow({
              label: safeConstant('B'),
              value: safeCount(undefined),
              verdict: 'healthy',
              evidence: EVIDENCE_ABSENT,
              note: 'n',
            }),
          ],
          findings: [],
        },
      ],
    })

    expect(across.reportLines.join('\n')).toContain('- Rows: 2 (1 answered · 1 no answer)')
  })

  it('reports a section with no rows as none rather than as zero answered', () => {
    const empty = buildSectionModel({
      id: 'account',
      blocks: [{ heading: safeConstant('Block'), description: 'd', rows: [], findings: [] }],
    })

    expect(empty.reportLines.join('\n')).toContain('- Rows: 0 (no rows)')
  })
})

describe('no section module bypasses the SafeValue brand', () => {
  const directory = __dirname

  const sectionModules = (): string[] =>
    readdirSync(directory).filter((name) => /Section\.ts$/.test(name) && !name.includes('.spec.'))

  it('can see the module it is guarding', () => {
    expect(readFileSync(join(directory, 'diagnosticsSections.ts'), 'utf8')).toContain('export type SafeValue')
  })

  it('scans a corpus that actually contains the section modules', () => {
    const modules = sectionModules()

    // `arrayContaining` rather than an exact list: a section landing later must
    // extend this corpus, not fail it. The point is that it cannot be EMPTY, and
    // cannot silently lose one of the sections already in the tree.
    expect(modules).toEqual(expect.arrayContaining(['browserSection.ts', 'environmentSection.ts']))
    expect(modules.length).toBeGreaterThanOrEqual(2)
  })

  it('finds no `as SafeValue` in any section module', () => {
    for (const name of sectionModules()) {
      // `as unknown as SafeValue` contains this substring too, so one check
      // covers both spellings of the bypass.
      expect(readFileSync(join(directory, name), 'utf8')).not.toContain('as SafeValue')
    }
  })
})
