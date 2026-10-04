import { FunctionComponent } from 'react'

import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { Chip, RemedyBlock } from './diagnosticsPresentation'
import { CAPABILITY_OUTCOME_CHIP, capabilityOutcomeState } from './syncDiagnostics'
import {
  blockWorstVerdict,
  isBlockEmpty,
  VERDICT_CHIP_LABEL,
  TONE_FOR_VERDICT,
  type DiagnosticBlock,
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
 * It makes three claims of its own and no others:
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
 *
 * NO ICONS. An `Icon` with a `type` missing from `IconNameToSvgMapping.ts`
 * renders its own name as literal text, and tsc and any `Icon`-mocking spec are
 * both blind to it. This renderer is text-only and `DiagnosticsSection.render.spec.tsx`
 * asserts that it emits no SVG at all, so the hazard cannot enter a section
 * without that assertion failing first.
 */

const BlockView: FunctionComponent<{ block: DiagnosticBlock }> = ({ block }) => {
  const worst = blockWorstVerdict(block)

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm font-semibold">{block.heading}</div>
        <Chip tone={TONE_FOR_VERDICT[worst]}>{VERDICT_CHIP_LABEL[worst]}</Chip>
      </div>
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
                <tr key={row.label} className="border-border border-t align-top">
                  <td className="py-2 pr-4 font-semibold">{row.label}</td>
                  <td className="py-2 pr-4 font-mono">{row.value}</td>
                  <td className="py-2 pr-4">
                    <Chip tone={row.tone}>{VERDICT_CHIP_LABEL[row.verdict]}</Chip>
                  </td>
                  <td className="text-passive-0 py-2">
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
    </div>
  )
}

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
