import { FunctionComponent } from 'react'

import Icon from '@/Components/Icon/Icon'
import type { IconNameToSvgMapping } from '@/Components/Icon/IconNameToSvgMapping'
import { EFFORT_LABEL, type Remedy, type RemedyEffort } from './diagnosticRemedies'
import { VERDICT_CHIP_LABEL, type DiagnosticFinding, type Verdict } from './diagnosticsSections'
import type { Tone } from './syncDiagnostics'

/**
 * Standard Red Notes: the presentation primitives every diagnostics surface
 * shares — the status chip, the tone chip and the finding card.
 *
 * SECURITY: every component here renders only what it is handed, and `Remedy`
 * carries no server-authored prose for them to render: each `Remedy` constructor
 * takes a closed union of literals this build compiled in, so there is no server
 * string in a remedy to redact. A redaction applied HERE would leave the copyable
 * report unprotected, which is why the guarantee is held where the remedy is
 * constructed and not where it is painted.
 *
 * *** ICONS, AND WHY THE RULE AGAINST THEM IS REVERSED RATHER THAN IGNORED. ***
 * This module used to say "NO ICONS, ON PURPOSE", and the reason was sound: an
 * `Icon` whose `type` is missing from `IconNameToSvgMapping` renders its own name
 * as literal text, `VectorIconNameOrEmoji` admits any string so tsc cannot see it,
 * and a spec that mocks `Icon` cannot either. That defect has shipped three times
 * elsewhere in this app. So the pane signalled status with a word on a tinted
 * background — colour alone, in other words, plus four words (`OK`, `Unknown`,
 * `Info`, `Degraded`) the eye has to read rather than recognise.
 *
 * The hazard is closed here by TYPE rather than by abstinence. `STATUS_ICON` is a
 * `Record<Verdict, MappedIconName>`, and `MappedIconName` is the key set of the
 * mapping object itself — not the wide type `Icon` accepts. A name that is not in
 * the mapping does not compile. `diagnosticsPresentation.render.spec.tsx` holds
 * the other half, because a type is erased: it mounts the REAL `Icon` for every
 * verdict and asserts an `svg` was produced and no fallback `label` was.
 *
 * Every icon is DECORATIVE and says so (`aria-hidden`, which `Icon` sets when it
 * is given no label). The word beside it is the accessible name, so the status is
 * carried three ways — a word, a shape and a colour — and by the word alone to a
 * reader who gets neither of the others.
 */

/** A name the icon mapping can actually render. NOT the wide type `Icon` accepts. */
export type MappedIconName = keyof typeof IconNameToSvgMapping

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The shape each status is recognised by.
 *
 * Chosen so that no two are distinguishable only by colour: a filled tick, a
 * triangle, a filled cross, a clock, a question mark, a dash and an "i" are seven
 * outlines. `untested` is a clock and not a question mark for the reason the
 * verdict was split out at all — it is something pending, with a known next step,
 * and the question mark belongs to the one status that genuinely does not know.
 */
export const STATUS_ICON: Record<Verdict, MappedIconName> = {
  healthy: 'check-circle-filled',
  degraded: 'warning',
  broken: 'clear-circle-filled',
  untested: 'clock',
  undetermined: 'help',
  'not-applicable': 'subtract',
  informational: 'info',
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The colours each status paints with.
 *
 * Theme tokens only, so both themes follow without a second table. `untested`
 * takes the info colour and `undetermined` does not: the two used to share one
 * grey chip reading "Unknown", which is how a check nobody had run came to look
 * exactly like a reading that failed to arrive.
 */
export const STATUS_STYLE: Record<Verdict, string> = {
  healthy: 'bg-success-faded text-success',
  degraded: 'bg-warning-faded text-warning',
  broken: 'bg-danger-faded text-danger',
  untested: 'bg-info-faded text-info',
  undetermined: 'bg-contrast text-text border border-border',
  'not-applicable': 'text-passive-1 border border-border',
  informational: 'bg-contrast text-passive-0',
}

/**
 * The status of one row, block, section or the whole pane.
 *
 * `label` overrides the word and never the icon or the colour: the headline says
 * "OK" where a row says "OK", but a section summary may want "Not tested" spelled
 * as a sentence. The verdict is on the element as `data-diagnostics-status`, which
 * is what a test asserts on — the word is copy and may change, the verdict is the
 * fact.
 */
export const StatusChip: FunctionComponent<{ verdict: Verdict; label?: string; large?: boolean }> = ({
  verdict,
  label,
  large = false,
}) => (
  <span
    data-diagnostics-status={verdict}
    className={`inline-flex items-center gap-1 rounded font-semibold tracking-wide whitespace-nowrap uppercase ${
      large ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
    } ${STATUS_STYLE[verdict]}`}
  >
    <Icon type={STATUS_ICON[verdict]} size={large ? 'normal' : 'small'} className="flex-shrink-0" />
    {label ?? VERDICT_CHIP_LABEL[verdict]}
  </span>
)

export const TONE_CHIP: Record<Tone, string> = {
  good: 'bg-success-faded text-success',
  warn: 'bg-warning-faded text-warning',
  bad: 'bg-danger-faded text-danger',
  neutral: 'bg-contrast text-neutral',
}

/** A plain tinted label, for things that are not a status: an effort, a count, a confirmation. */
export const Chip: FunctionComponent<{ tone: Tone; children: string }> = ({ tone, children }) => (
  <span className={`rounded px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${TONE_CHIP[tone]}`}>
    {children}
  </span>
)

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** The tone reads as "how reachable is this
 * fix from here": `account-setting`, `restart` and `device` are all something the
 * reader can do now, `rebuild`, `client-update` and `peer-service` need a build or
 * a service they may not control from here, `none` is a dead end and `wait` is not
 * a fix at all.
 *
 * `peer-service` deliberately does NOT share `wait`'s neutral tone. Neutral is the
 * tone of "nothing to do", and these findings have something to do; it is simply
 * somewhere else.
 *
 * `account-setting` is the most reachable member of all — a toggle on this very
 * screen's sibling tab, applying immediately with no restart — so it takes
 * `good` alongside the other two the reader can act on without leaving the app.
 *
 * `upgrade-server` sits with `rebuild` and `client-update` on `warn`: a build the
 * reader has to deploy rather than a setting they can change. `no-action` takes
 * `good` and NOT `wait`'s neutral — neutral is the tone of "look again", and a
 * finding whose correct action is none has nothing to look at. It is also
 * deliberately not `none`'s `bad`: "Not fixable here" over a state that is
 * working reads as a defect the reader cannot reach, which is the opposite of
 * what the finding says.
 */
export const EFFORT_TONE: Record<RemedyEffort, Tone> = {
  'account-setting': 'good',
  restart: 'good',
  rebuild: 'warn',
  'client-update': 'warn',
  'upgrade-server': 'warn',
  device: 'good',
  'peer-service': 'warn',
  none: 'bad',
  wait: 'neutral',
  'no-action': 'good',
}

/**
 * The steps and the evidence behind a remedy, FOLDED.
 *
 * The `because` list is not decoration. This panel's only asset is that it can be
 * believed, and the fastest way to lose that is a confident instruction with no
 * visible reasoning — the operator cannot tell a derived remedy from a canned one,
 * so a single wrong answer discredits all of them. Showing the observed facts
 * makes a wrong remedy falsifiable on sight.
 *
 * It is folded, and it used to be the whole card: five paragraphs under every
 * finding, so the one sentence that said what to do was the hardest thing on the
 * screen to find. Folded is not dropped — a closed `<details>` keeps every line in
 * the DOM, so the poisoned-sentinel sweep over the rendered pane still reads it.
 */
const RemedyReasoning: FunctionComponent<{ remedy: Remedy }> = ({ remedy }) => (
  <>
    {remedy.steps.length > 0 && (
      <ol className="mt-2 list-decimal pl-5 text-sm">
        {remedy.steps.map((step) => (
          <li key={step} className="mt-1">
            {step}
          </li>
        ))}
      </ol>
    )}
    {remedy.because.length > 0 && (
      <ul className="text-passive-0 mt-2 list-disc pl-5 text-sm">
        {remedy.because.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    )}
  </>
)

/** What a finding says when this build has no remedy for it. A statement about the CLIENT. */
export const NO_REMEDY_SENTENCE =
  'No fix is recorded in this client build for this finding. That is a gap in the client, not a statement that nothing can be done.'

/**
 * One finding: STATUS, one sentence of what is wrong, one action — and the
 * reasoning behind a fold.
 *
 * The order is the reader's, not the author's. Status first, because that is what
 * decides whether they read on; then the title, which is the one sentence; then
 * the remedy's `summary`, which `Remedy` already defines as "one sentence: the
 * thing to do, or the plain statement that nothing can be done". Everything else
 * — the long detail, the caveat on indirect evidence, the numbered steps and the
 * facts they rest on — is real and is one click away.
 *
 * `source` names where the finding was raised, for the list that gathers findings
 * from all five sections onto one screen.
 */
export const FindingCard: FunctionComponent<{ finding: DiagnosticFinding; source?: string }> = ({
  finding,
  source,
}) => (
  <div
    className="border-border rounded border p-3"
    data-diagnostics-finding={finding.code}
    data-diagnostics-finding-status={finding.verdict}
  >
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip verdict={finding.verdict} />
      <span className="text-sm font-semibold" data-diagnostics-finding-title="true">
        {finding.title}
      </span>
      {source !== undefined && <span className="text-passive-1 text-xs">{source}</span>}
    </div>
    <div className="mt-2 flex flex-wrap items-start gap-2 text-sm" data-diagnostics-finding-action="true">
      {finding.remedy !== undefined && (
        <Chip tone={EFFORT_TONE[finding.remedy.effort]}>{EFFORT_LABEL[finding.remedy.effort]}</Chip>
      )}
      {finding.remedy?.basis === 'generic' && <Chip tone="warn">Generic advice</Chip>}
      <span className="min-w-0 flex-1">{finding.remedy?.summary ?? NO_REMEDY_SENTENCE}</span>
    </div>
    <details className="mt-2" data-diagnostics-finding-reasoning="true">
      <summary className="text-passive-0 cursor-pointer text-xs">Why, and the full steps</summary>
      <div className="text-passive-0 mt-1 text-sm">{finding.detail}</div>
      {finding.caveat !== undefined && <div className="text-passive-0 mt-1 text-sm italic">{finding.caveat}</div>}
      {finding.remedy !== undefined && <RemedyReasoning remedy={finding.remedy} />}
    </details>
  </div>
)
