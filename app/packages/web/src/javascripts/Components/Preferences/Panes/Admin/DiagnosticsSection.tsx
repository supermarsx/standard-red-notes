import { FunctionComponent, useCallback, useState } from 'react'

import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { FindingCard, StatusChip } from './diagnosticsPresentation'
import {
  blockWorstVerdict,
  BLOCKS_OK,
  describeVerdictCensus,
  isBlockEmpty,
  readingCensus,
  readingOf,
  READING_MEANING,
  READING_TAG,
  ROW_READINGS,
  verdictCensus,
  VERDICT_CHIP_LABEL,
  VERDICT_MEANING,
  VERDICT_SEVERITY,
  VERDICTS,
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
 *     not establish it gets whatever its evidence earned on screen and the caveat
 *     printed beneath — the whole reason `diagnosticsSections.ts` derives the
 *     verdict from evidence.
 *   - A block with nothing in it says so, in words. An empty panel is a question
 *     the operator has to answer themselves, and "the server reported nothing"
 *     and "everything is fine" are the two answers they would guess between.
 *   - Every chip label comes from an exhaustive `Record`. The ternary chain this
 *     replaces (`tone === 'good' ? 'OK' : tone === 'bad' ? 'Down' : 'Note'`)
 *     printed "Note" for a row the panel could not determine, which reads as a
 *     footnote rather than as an admission.
 *   - *** THE SILENCES ARE SEPARABLE BY EYE. *** A row whose value arrived, one
 *     this build asked about and got nothing for, one a check has not tested yet,
 *     one with nothing to report and one nothing here can produce are five
 *     different facts. Each silence carries a tag of its own and every row
 *     carries `data-diagnostics-reading`.
 *   - *** THE NOISE COLLAPSES AND IS NEVER DROPPED. *** A block is open when it
 *     has something to act on — a finding, or a verdict that keeps the section
 *     off OK — and collapsed otherwise. Collapsed means a closed `<details>`:
 *     every row stays in the DOM, so nothing is unreachable, nothing is deleted,
 *     and the poisoned-sentinel sweep over the rendered text still sees every row
 *     it is asserting about. A renderer that omitted the rows would make that
 *     sweep pass vacuously, which is the second-worst outcome available here.
 *
 * ROWS ARE NEVER REORDERED. Grouping them by reading or by verdict would read
 * better in the abstract and would break the prose: more than fifty row notes in
 * the five sections refer to "the row above" or "the row below" — several of them
 * load-bearing, like the secure-context row that the page-scheme row sends the
 * reader to first. The collapse is therefore at BLOCK granularity, where no note
 * depends on the order.
 *
 * ICONS come from `StatusChip` and from nowhere else in this file: see
 * `diagnosticsPresentation.tsx` for why an unmapped icon name cannot compile
 * there, and `DiagnosticsSection.render.spec.tsx` for the assertion that every
 * status on a rendered section drew a glyph and none fell back to its own name.
 *
 * NO BUTTONS, and that is asserted. The disclosure control is a `<summary>`: a
 * `<button>` in a section would be indistinguishable in that assertion from a
 * control that starts a check, and checks are started from the pane's header and
 * the Checks tab only.
 */

/**
 * The tag on a row whose value is a silence rather than a reading.
 *
 * Rendered for the silences and NOT for `answered`, because the value column
 * already carries the answer and a tag reading "answered" beside it is ink with
 * no information in it. The legend under the section title says so explicitly, so
 * the absence of a tag is a documented state rather than something the reader has
 * to infer.
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
 * Beyond that the test is whether any ROW in the block keeps the section off OK —
 * read from `BLOCKS_OK`, the same record the headline is derived from, so the
 * screen cannot fold away the reason its own headline gives. A block that is all
 * OK, context and not-applicable stays CLOSED.
 *
 * Asked of the ROWS, not of `blockWorstVerdict`: a block with no rows at all has
 * a worst verdict of `undetermined` by the empty-list rule, and takes no part in
 * its section's status because it contributes no verdict to it. Opening it would
 * put an empty panel in front of the reader as though it were the reason.
 */
export function blockOpensByDefault(block: DiagnosticBlock): boolean {
  return block.findings.length > 0 || block.rows.some((row) => BLOCKS_OK[row.verdict])
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
  const verdicts = verdictCensus(block.rows.map((row) => row.verdict))

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
          <StatusChip verdict={worst} />
          {block.rows.length > 0 && (
            <span className="text-passive-0 text-xs" data-diagnostics-block-counts="true">
              {describeVerdictCensus(verdicts)}
            </span>
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

      {block.findings.length > 0 && (
        <ul className="mt-3 flex list-none flex-col gap-2">
          {block.findings.map((finding) => (
            <li key={finding.code}>
              <FindingCard finding={finding} />
            </li>
          ))}
        </ul>
      )}

      {/* ROWS THAT WRAP. This was a table as wide as its widest line (`min-w-max`)
          in a box that scrolled sideways, with the note in a fourth column: on an
          ordinary desktop pane the note of every row began near the right edge
          and ran out of view, so the sentence that says what a row means had to
          be scrolled to, block by block. Label, value and status share a line
          and the note takes the full width beneath them; nothing scrolls.

          STILL FOUR CELLS, in the same order, in a `tr`: the specs read them by
          index. Only how they are laid out changed, and the roles are spelled
          out because a row that is displayed as a grid loses its implicit one. */}
      {block.rows.length > 0 && (
        <table className="mt-2 block w-full text-left text-sm" role="table">
          <tbody className="block" role="rowgroup">
            {block.rows.map((row) => (
              <tr
                key={row.label}
                role="row"
                className="border-border grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-x-4 gap-y-1 border-t py-2"
                data-diagnostics-reading={readingOf(row.value)}
                data-diagnostics-row-status={row.verdict}
              >
                <td role="cell" className="font-semibold break-words">
                  {row.label}
                </td>
                <td role="cell" className="font-mono break-words">
                  {row.value}
                </td>
                <td role="cell" className="whitespace-nowrap">
                  <StatusChip verdict={row.verdict} />
                </td>
                <td role="cell" className="text-passive-0 col-span-3 break-words whitespace-normal">
                  <ReadingTag reading={readingOf(row.value)} />
                  {row.caveat !== undefined && <div className="text-text mb-1">{row.caveat}</div>}
                  {row.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}

/**
 * The legend, printed once per section.
 *
 * Composed from the same exhaustive `Record`s the chips, the tags and the copyable
 * report read, so the screen and the paste cannot describe a status differently.
 * Every status is listed WITH its chip, so the legend is also the one place a
 * reader can see all seven shapes side by side.
 */
const StatusLegend: FunctionComponent = () => (
  <details className="mt-1" data-diagnostics-legend="true">
    <summary className="text-passive-0 cursor-pointer text-xs">What the statuses mean</summary>
    <ul className="mt-2 flex list-none flex-col gap-1 text-sm">
      {[...VERDICTS]
        .sort((left, right) => VERDICT_SEVERITY[right] - VERDICT_SEVERITY[left])
        .map((verdict) => (
          <li key={verdict} className="flex flex-wrap items-center gap-2">
            <StatusChip verdict={verdict} />
            <span className="text-passive-0">{VERDICT_MEANING[verdict]}</span>
          </li>
        ))}
    </ul>
    <Text className="mt-2">
      {`A value in the value column means ${READING_MEANING.answered}. `}
      {ROW_READINGS.filter((reading) => reading !== 'answered')
        .map((reading) => `“${READING_TAG[reading]}” means ${READING_MEANING[reading]}`)
        .join('. ')}
      {'. Blocks with something to act on are open; the rest are collapsed and nothing is omitted.'}
    </Text>
  </details>
)

const DiagnosticsSection: FunctionComponent<{ model: SectionModel }> = ({ model }) => (
  <PreferencesSegment>
    <div data-diagnostics-section={model.id} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3">
        <Subtitle>{model.title}</Subtitle>
        <StatusChip verdict={model.worstVerdict} />
        <span className="text-passive-0 text-xs" data-diagnostics-section-counts="true">
          {describeVerdictCensus(model.counts)}
        </span>
      </div>
      {model.headline !== undefined && (
        <Text className="mt-1">{`${VERDICT_CHIP_LABEL[model.headline.verdict]}: ${model.headline.title}`}</Text>
      )}
      {model.blocks.length === 0 && (
        <Text className="mt-2">
          This section produced no blocks, which means nothing it reads was available. No verdict is claimed.
        </Text>
      )}
      {model.blocks.length > 0 && <StatusLegend />}
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
