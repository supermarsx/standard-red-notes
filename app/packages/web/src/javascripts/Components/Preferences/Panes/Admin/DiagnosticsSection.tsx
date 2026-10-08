import { FunctionComponent, useCallback, useState } from 'react'

import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { Chip, RemedyBlock } from './diagnosticsPresentation'
import { CAPABILITY_OUTCOME_CHIP, capabilityOutcomeState } from './syncDiagnostics'
import {
  blockWorstVerdict,
  describeCensus,
  isBlockEmpty,
  readingCensus,
  readingOf,
  READING_MEANING,
  READING_TAG,
  ROW_READINGS,
  VERDICT_CHIP_LABEL,
  VERDICT_SEVERITY,
  TONE_FOR_VERDICT,
  type DiagnosticBlock,
  type RowReading,
  type SectionModel,
} from './diagnosticsSections'

/**
 * Standard Red Notes: the ONE renderer for every diagnostics section.
 *
 * There is exactly one of these and five pure model builders, which is what lets
 * the sections be written in parallel without two of them meeting in a file. It
 * also keeps the pane's existing boundary intact: everything that decides what
 * the operator is TOLD is testable without a DOM, and this file only paints it.
 *
 * It makes five claims of its own and no others:
 *
 *   - The chip beside a row shows the row's CAPPED verdict, never the one the
 *     builder asked for. A builder that claims "healthy" from a signal that does
 *     not establish it gets "Unknown" on screen and the caveat printed beneath —
 *     the whole reason `diagnosticsSections.ts` derives tone from evidence.
 *   - A block with nothing in it says so, in words. An empty panel is a question
 *     the operator has to answer themselves, and "the server reported nothing"
 *     and "everything is fine" are the two answers they would guess between.
 *   - Every chip label comes from an exhaustive `Record`. The ternary chain this
 *     replaces (`tone === 'good' ? 'OK' : tone === 'bad' ? 'Down' : 'Note'`)
 *     printed "Note" for a row the panel could not determine, which reads as a
 *     footnote rather than as an admission.
 *   - *** THE THREE SILENCES ARE SEPARABLE BY EYE. *** A row whose value arrived,
 *     a row this build asked about and got nothing for, and a row nothing in the
 *     system publishes are three different facts that the pane models carefully
 *     and used to print as two sentences a reader had to parse. The two silences
 *     now carry a tag of their own and every row carries
 *     `data-diagnostics-reading`, and each block states its own census so "this
 *     block reported twelve facts" is distinguishable at a glance from "this
 *     block reported three facts and nine silences".
 *   - *** THE NOISE COLLAPSES AND IS NEVER DROPPED. *** A block is open when it
 *     has something to act on — a finding, or a degraded or broken verdict — and
 *     collapsed otherwise. Collapsed means a closed `<details>`: every row stays
 *     in the DOM, so nothing is unreachable, nothing is deleted, and the
 *     poisoned-sentinel sweep over the rendered text still sees every row it is
 *     asserting about. A renderer that omitted the rows would make that sweep
 *     pass vacuously, which is the second-worst outcome available here.
 *
 * ROWS ARE NEVER REORDERED. Grouping them by reading or by verdict would read
 * better in the abstract and would break the prose: more than fifty row notes in
 * the five sections refer to "the row above" or "the row below" — several of them
 * load-bearing, like the secure-context row that the page-scheme row sends the
 * reader to first. The collapse is therefore at BLOCK granularity, where no note
 * depends on the order.
 *
 * NO ICONS. An `Icon` with a `type` missing from `IconNameToSvgMapping.ts`
 * renders its own name as literal text, and tsc and any `Icon`-mocking spec are
 * both blind to it. This renderer is text-only and `DiagnosticsSection.render.spec.tsx`
 * asserts that it emits no SVG at all, so the hazard cannot enter a section
 * without that assertion failing first.
 *
 * NO BUTTONS EITHER, and that is also asserted. The disclosure control is a
 * `<summary>`: a `<button>` in a section would be indistinguishable in that
 * assertion from a control that starts a probe run, and probes are started in
 * exactly one place.
 */

/**
 * The tag on a row whose value is a silence rather than a reading.
 *
 * Rendered for the two silences and NOT for `answered`, because the value column
 * already carries the answer and a tag reading "answered" beside it is ink with
 * no information in it. The legend under the section title says so explicitly, so
 * the absence of a tag is a documented third state rather than something the
 * reader has to infer.
 *
 * It sits inside the NOTE cell, not a cell of its own. That is a deliberate
 * constraint rather than a layout preference: the row's four cells are label,
 * value, verdict and note, and two specs plus the whole Admin tab suite read
 * those by index. A fifth cell would renumber them, and renumbering sixty
 * assertions to add a tag is how a test gets weakened on the way past.
 */
const ReadingTag: FunctionComponent<{ reading: RowReading }> = ({ reading }) => {
  if (reading === 'answered') {
    return null
  }

  return (
    <span
      className="bg-contrast text-neutral mr-2 rounded px-1.5 py-0.5 align-middle text-[0.65rem] font-semibold tracking-wide uppercase"
      title={READING_MEANING[reading]}
    >
      {READING_TAG[reading]}
    </span>
  )
}

/**
 * Whether a block is worth opening before the operator asks.
 *
 * A finding is always worth opening: it is the thing this pane exists to raise.
 * Beyond that the test is the block's own worst verdict, ranked on the same
 * `VERDICT_SEVERITY` the sub-tab chips and the report's action list use, so the
 * screen and the report cannot come to disagree about what matters. `undetermined`
 * stays CLOSED and `degraded` opens: that is the one judgement here, and it is
 * the pane's own ranking — undetermined is above healthy because it is worth
 * opening, and below degraded because it is not worth opening first.
 */
export function blockOpensByDefault(block: DiagnosticBlock): boolean {
  return block.findings.length > 0 || VERDICT_SEVERITY[blockWorstVerdict(block)] >= VERDICT_SEVERITY.degraded
}

const BlockView: FunctionComponent<{ block: DiagnosticBlock }> = ({ block }) => {
  const worst = blockWorstVerdict(block)
  // The initial value is read ONCE, on mount. It must not be re-applied from the
  // model: the tab re-reads the transport every two seconds and rebuilds these
  // models, so a block whose `open` attribute tracked the model would snap shut
  // under the operator's hands twice a second. The `onToggle` handler is what
  // keeps React's idea of the state and the DOM's in step after a manual toggle.
  const [open, setOpen] = useState(() => blockOpensByDefault(block))
  const onToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open)
  }, [])
  const census = readingCensus(block.rows)

  return (
    <details
      className="mt-4"
      data-diagnostics-block={block.heading}
      data-diagnostics-census={ROW_READINGS.map((reading) => `${reading}=${census[reading]}`).join(',')}
      open={open}
      // *** REACT'S OWN IDEA OF THE STATE, AS AN ATTRIBUTE. ***
      //
      // Not decoration, and not a debugging leftover. React does not rewrite a DOM
      // attribute whose rendered value has not changed, and `<details>` is toggled
      // by the BROWSER rather than by React — so "the state tracked the operator's
      // toggle" and "the state is stale and React simply never wrote over it" are
      // indistinguishable from `details.open` alone. A mutation that re-imposed the
      // model's opinion on every render survived a test that could only read
      // `.open`. This is the witness that separates the two, and the spec asserts
      // on both.
      data-diagnostics-open={String(open)}
      onToggle={onToggle}
    >
      <summary className="list-item cursor-pointer">
        <span className="inline-flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">{block.heading}</span>
          <Chip tone={TONE_FOR_VERDICT[worst]}>{VERDICT_CHIP_LABEL[worst]}</Chip>
          {block.rows.length > 0 && (
            <span className="text-passive-0 text-xs">{`${block.rows.length} rows: ${describeCensus(census)}`}</span>
          )}
          {block.findings.length > 0 && (
            <span className="text-xs font-semibold">{`${block.findings.length} finding(s)`}</span>
          )}
        </span>
      </summary>

      <div className="text-passive-0 mt-1 text-sm">{block.description}</div>

      {isBlockEmpty(block) && (
        <div className="mt-2 text-sm">
          {block.emptyNote ??
            'Nothing was reported for this block, so no verdict is claimed. That is not the same as everything being fine.'}
        </div>
      )}

      {block.rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-max text-left text-sm">
            <tbody>
              {block.rows.map((row) => (
                <tr
                  key={row.label}
                  className="border-border border-t align-top"
                  data-diagnostics-reading={readingOf(row.value)}
                >
                  <td className="py-2 pr-4 font-semibold">{row.label}</td>
                  <td className="py-2 pr-4 font-mono">{row.value}</td>
                  <td className="py-2 pr-4">
                    <Chip tone={row.tone}>{VERDICT_CHIP_LABEL[row.verdict]}</Chip>
                  </td>
                  <td className="text-passive-0 py-2">
                    <ReadingTag reading={readingOf(row.value)} />
                    {row.note}
                    {row.caveat !== undefined && <div className="mt-1 italic">{row.caveat}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {block.findings.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {block.findings.map((finding) => (
            <li key={finding.code} className="border-border rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={finding.tone}>{VERDICT_CHIP_LABEL[finding.verdict]}</Chip>
                <span className="text-sm font-semibold">{finding.title}</span>
              </div>
              <div className="text-passive-0 mt-1 text-sm">{finding.detail}</div>
              {finding.caveat !== undefined && (
                <div className="text-passive-0 mt-1 text-sm italic">{finding.caveat}</div>
              )}
              {finding.remedy && <RemedyBlock remedy={finding.remedy} />}
            </li>
          ))}
        </ul>
      )}

      {(block.outcomes ?? []).length > 0 && (
        <>
          {/* Read-only ON PURPOSE. One of the probes mints a real server-side
              ticket for the operator's own session, so the consent paragraph and
              the button that starts a run live in exactly one place — a warning
              repeated in five sections is a warning nobody reads. */}
          <div className="mt-3 text-sm font-semibold">Check results</div>
          <div className="text-passive-0 text-sm">
            Results from the last run on the Checks sub-tab, which is also the only place a run can be started.
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {(block.outcomes ?? []).map((outcome) => (
              <li key={outcome.name} className="border-border rounded border p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={CAPABILITY_OUTCOME_CHIP[capabilityOutcomeState(outcome)].tone}>
                    {CAPABILITY_OUTCOME_CHIP[capabilityOutcomeState(outcome)].label}
                  </Chip>
                  <span className="text-sm font-semibold">{outcome.name}</span>
                </div>
                <div className="text-passive-0 mt-1 text-sm">{outcome.detail}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  )
}

/**
 * The row-reading legend, printed once per section.
 *
 * Composed from the same exhaustive `Record`s the tags and the copyable report
 * read, so the screen and the paste cannot describe the three states differently.
 * The `answered` entry is spelled out even though it has no tag, because "a row
 * with no tag carried a value" is exactly the inference a reader should not have
 * to make on their own.
 */
const ReadingLegend: FunctionComponent = () => (
  <Text className="mt-1">
    {`Row readings: a value in the value column means ${READING_MEANING.answered}. `}
    {`${READING_TAG.unanswered} means ${READING_MEANING.unanswered}. `}
    {`${READING_TAG.unpublished} means ${READING_MEANING.unpublished}. `}
    {'Blocks with something to act on are open; the rest are collapsed and nothing is omitted.'}
  </Text>
)

const DiagnosticsSection: FunctionComponent<{ model: SectionModel }> = ({ model }) => (
  <PreferencesSegment>
    <div data-diagnostics-section={model.id} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3">
        <Subtitle>{model.title}</Subtitle>
        <Chip tone={model.worst}>{VERDICT_CHIP_LABEL[model.worstVerdict]}</Chip>
      </div>
      {model.headline !== undefined && <Text className="mt-1">{model.headline.title}</Text>}
      {model.blocks.length === 0 && (
        <Text className="mt-2">
          This section produced no blocks, which means nothing it reads was available. No verdict is claimed.
        </Text>
      )}
      {model.blocks.length > 0 && <ReadingLegend />}
      {model.blocks.map((block, index) => (
        <div key={block.heading}>
          {index > 0 && <HorizontalSeparator classes="mt-4" />}
          <BlockView block={block} />
        </div>
      ))}
    </div>
  </PreferencesSegment>
)

export default DiagnosticsSection
