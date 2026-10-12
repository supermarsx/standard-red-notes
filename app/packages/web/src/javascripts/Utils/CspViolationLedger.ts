/**
 * What this page's Content-Security-Policy has refused, counted since the page loaded.
 *
 * *** WHY IT IS COUNTED AT ALL. *** A CSP refusal is silent everywhere except the
 * browser's console. The page keeps running with a script that never ran, a
 * stylesheet that never applied or a request that never left, and the symptom —
 * a diagram drawn in the wrong font, a feature that quietly does nothing —
 * points nowhere near the policy. Twice a console pasted from a deployment was
 * read as one cause when it was two page loads; a count kept by the page that
 * raised it cannot be misattributed.
 *
 * *** WHAT IT KEEPS, AND WHAT IT REFUSES TO. *** One counter per DIRECTIVE, from a
 * closed list, and how many refusals were enforced as opposed to report-only.
 * Nothing else. The event also carries the blocked URI, the document URI, the
 * source file, a sample of the refused script and the policy text itself — every
 * one of which is an address, a path or code — and none of them is read, so
 * none of them can reach the diagnostics pane or the report it copies. A
 * directive this build has no name for is counted as `other` and never echoed.
 *
 * *** ARMED BEFORE THE APPLICATION EVALUATES. *** Imported for its side effect
 * from the entry module, above `./App`, so a refusal during startup is counted.
 * It cannot see one that happened before this module ran — a refused inline
 * bootstrap means no module runs at all — which is why the reading carries how
 * long it has been armed, and why a zero is "none observed", not "none".
 */

export const CSP_DIRECTIVES = [
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'frame-src',
  'child-src',
  'worker-src',
  'object-src',
  'manifest-src',
  'form-action',
  'frame-ancestors',
  'base-uri',
] as const

export type CspDirective = (typeof CSP_DIRECTIVES)[number]

/** A directive this build cannot name. Counted, never printed. */
export const CSP_UNRECOGNISED_DIRECTIVE = 'other'

export type CspLedgerDirective = CspDirective | typeof CSP_UNRECOGNISED_DIRECTIVE

export type CspViolationReading = {
  /** Refusals observed since the ledger was armed. */
  readonly total: number
  /** Of those, how many the browser ENFORCED. The rest were report-only and blocked nothing. */
  readonly enforced: number
  readonly byDirective: Readonly<Partial<Record<CspLedgerDirective, number>>>
  /** How long the ledger has been listening. A DURATION, never an instant. */
  readonly armedForMs: number
}

type ViolationLike = {
  readonly effectiveDirective?: unknown
  readonly violatedDirective?: unknown
  readonly disposition?: unknown
}

const KNOWN: ReadonlySet<string> = new Set<string>(CSP_DIRECTIVES)

/**
 * The directive, closed. `effectiveDirective` is the specific one that fired;
 * older engines only fill `violatedDirective`, which may carry the directive's
 * VALUE after a space — only the first token is the name, and only a name on
 * the closed list is kept.
 */
function directiveOf(event: ViolationLike): CspLedgerDirective {
  for (const candidate of [event.effectiveDirective, event.violatedDirective]) {
    if (typeof candidate !== 'string') {
      continue
    }
    const name = candidate.trim().split(/\s+/)[0]
    if (KNOWN.has(name)) {
      return name as CspDirective
    }
  }

  return CSP_UNRECOGNISED_DIRECTIVE
}

export class CspViolationLedger {
  private readonly counts = new Map<CspLedgerDirective, number>()
  private total = 0
  private enforced = 0
  private readonly armedAt: number

  constructor(private readonly now: () => number = () => Date.now()) {
    this.armedAt = now()
  }

  record(event: ViolationLike): void {
    const directive = directiveOf(event)
    this.counts.set(directive, (this.counts.get(directive) ?? 0) + 1)
    this.total += 1
    // Anything that is not explicitly report-only blocked something.
    if (event.disposition !== 'report') {
      this.enforced += 1
    }
  }

  reading(): CspViolationReading {
    const byDirective: Partial<Record<CspLedgerDirective, number>> = {}
    for (const [directive, count] of this.counts) {
      byDirective[directive] = count
    }

    return {
      total: this.total,
      enforced: this.enforced,
      byDirective,
      armedForMs: Math.max(0, this.now() - this.armedAt),
    }
  }
}

let installed: CspViolationLedger | undefined

/**
 * Arm the page's one ledger. Idempotent: a second call returns the first ledger
 * and adds no second listener, so the counts cannot double.
 */
export function installCspViolationLedger(
  target: Pick<Document, 'addEventListener'> | undefined = typeof document === 'undefined' ? undefined : document,
): CspViolationLedger | undefined {
  if (installed !== undefined || target === undefined) {
    return installed
  }

  const ledger = new CspViolationLedger()
  try {
    target.addEventListener('securitypolicyviolation', (event) => ledger.record(event as unknown as ViolationLike))
  } catch {
    // An environment that cannot listen has nothing to count; say so by absence.
    return undefined
  }
  installed = ledger

  return ledger
}

/** What the page's ledger has counted, or nothing when no ledger was ever armed. */
export function readCspViolations(): CspViolationReading | undefined {
  return installed?.reading()
}

installCspViolationLedger()
