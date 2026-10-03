import { FunctionComponent } from 'react'

import { EFFORT_LABEL, type Remedy, type RemedyEffort } from './diagnosticRemedies'
import type { Tone } from './syncDiagnostics'

/**
 * Standard Red Notes: the two presentation primitives every diagnostics section
 * shares — the tone chip and the remedy block.
 *
 * They were defined inside `AdminDiagnosticsTab.tsx` while that file was the only
 * thing that rendered a diagnostic. It is not any more: the pane is being split
 * into one generic section renderer (`DiagnosticsSection.tsx`) plus a pure model
 * builder per section, and both the renderer and the tab need these. Copied here
 * VERBATIM, doc comments included, rather than re-written: the comments record
 * bugs these two components were corrected for, and a paraphrase loses that.
 *
 * There are deliberately two copies in the tree for the duration of the split —
 * this module and the originals in `AdminDiagnosticsTab.tsx` — because that file
 * is owned by another change in flight. The integration step deletes the
 * originals and imports these, leaving exactly one copy. Until then, a change to
 * either must be made to both.
 *
 * SECURITY: both components render only what they are handed. `Remedy.summary`
 * is the one place server-authored prose reaches the screen and it is passed
 * through `sanitizeServerCopy` where the remedy is CONSTRUCTED
 * (`diagnosticRemedies.ts`), not here — a redaction applied at render time would
 * leave the copyable report unprotected.
 *
 * NO ICONS, ON PURPOSE. An `Icon` whose `type` is not in
 * `Components/Icon/IconNameToSvgMapping.ts` renders its own name as literal text,
 * and both tsc and any spec that mocks `Icon` are blind to it. The chips here are
 * text, so that hazard cannot occur in a diagnostics section at all.
 */

export const TONE_CHIP: Record<Tone, string> = {
  good: 'bg-success-faded text-success',
  warn: 'bg-warning-faded text-warning',
  bad: 'bg-danger-faded text-danger',
  neutral: 'bg-contrast text-neutral',
}

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
 */
export const EFFORT_TONE: Record<RemedyEffort, Tone> = {
  'account-setting': 'good',
  restart: 'good',
  rebuild: 'warn',
  'client-update': 'warn',
  device: 'good',
  'peer-service': 'warn',
  none: 'bad',
  wait: 'neutral',
}

/**
 * A remedy, rendered so the operator can see BOTH the instruction and the
 * evidence it rests on.
 *
 * The `because` list is not decoration. This panel's only asset is that it can be
 * believed, and the fastest way to lose that is a confident instruction with no
 * visible reasoning — the operator cannot tell a derived remedy from a canned
 * one, so a single wrong answer discredits all of them. Showing the observed
 * facts makes a wrong remedy falsifiable on sight.
 */
export const RemedyBlock: FunctionComponent<{ remedy: Remedy }> = ({ remedy }) => (
  <div className="border-border mt-2 rounded border border-dashed p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone={EFFORT_TONE[remedy.effort]}>{EFFORT_LABEL[remedy.effort]}</Chip>
      {remedy.basis === 'generic' && <Chip tone="warn">Generic advice</Chip>}
      <span className="text-sm font-semibold">How to fix</span>
    </div>
    <div className="mt-1 text-sm">{remedy.summary}</div>
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
  </div>
)
