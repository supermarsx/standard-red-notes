import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import {
  applyMermaidLineStyle,
  applyMermaidLook,
  applyMermaidSpacing,
  applyMermaidTextSize,
  applyMermaidTheme,
  DEFAULT_MERMAID_LINE_STYLE,
  DEFAULT_MERMAID_SPACING,
  DEFAULT_MERMAID_TEXT_SIZE,
  describeMermaidTextSize,
  describeMermaidThemeSource,
  MAX_MERMAID_SPACING,
  MAX_MERMAID_TEXT_SIZE,
  MERMAID_LIBRARY_THEME_LABELS,
  MERMAID_LINE_STYLE_LABELS,
  MERMAID_LINE_STYLES,
  MERMAID_LOOK_LABELS,
  MERMAID_LOOKS,
  MERMAID_SPACING_LEVELS,
  MERMAID_SPACING_STEP,
  MERMAID_TEXT_SIZE_STEPS,
  type MermaidControlReading,
  type MermaidCustomiseEdit,
  mermaidCustomiseKind,
  mermaidKindPhrase,
  type MermaidLineStyle,
  MIN_MERMAID_SPACING,
  MIN_MERMAID_TEXT_SIZE,
  readMermaidDirectiveOverrides,
  readMermaidEffectiveTheme,
  readMermaidLineStyle,
  readMermaidLook,
  readMermaidSpacing,
  readMermaidTextSize,
  reshuffleMermaidSketch,
} from './MermaidConfigCatalog'
import { keepEditorFocus, MERMAID_GROUP_CLASS, MERMAID_SELECT_CLASS, mermaidSegmentClass } from './MermaidControlStyles'
import {
  MERMAID_LIBRARY_THEMES,
  MERMAID_THEME_MODE_LABELS,
  type MermaidLibraryTheme,
  type MermaidThemeMode,
} from './MermaidSettings'
import {
  describeUnreadableFrontmatter,
  type MermaidConfigRefusal,
  readMermaidSourceConfig,
} from './MermaidSourceConfig'
import {
  activeMermaidStylePreset,
  applyMermaidStylePreset,
  MERMAID_STYLE_PRESETS,
  mermaidCustomisationCanReset,
  mermaidStylePresetAvailability,
  resetMermaidCustomisation,
} from './MermaidStylePresets'

/**
 * Standard Red Notes — the Customise panel for a Mermaid diagram: one-click
 * presets, mermaid's eleven themes, the hand-drawn look, text size, spacing,
 * line style, and Reset.
 *
 * EVERYTHING IT CHANGES IS WRITTEN INTO THE DIAGRAM'S OWN TEXT, as a
 * frontmatter `config:` block, so a look chosen here survives export, copy and
 * paste, an older build of this app and any other mermaid tool. The panel
 * stores nothing of its own: what each control shows is read back out of the
 * text on every render (MermaidConfigCatalog.ts), so it is as true of a
 * diagram pasted from mermaid's documentation as of one styled here.
 *
 * It works for every kind of diagram, and says so honestly: a control mermaid
 * has no working option for — a hand-drawn pie chart, spacing in a class
 * diagram — is shown with the reason instead of a switch that does nothing.
 *
 * IT NEVER REWRITES A FRONTMATTER IT CANNOT KEEP EXACTLY. A change that is
 * refused — a YAML comment in the way, an init directive that would override
 * the choice — shows the reason here, in the panel, and leaves the text alone.
 *
 * Pure, on the `MermaidSettingsPanel` model: the diagram's text and the block's
 * theme arrive as props and every change leaves through `onApply`. Nothing
 * here touches the editor, so the whole panel is exercisable directly in jsdom.
 *
 * ITS STATE IS ITS OWN. A slider being dragged holds its draft in this
 * component and commits once the drag ends; the editor toolbar that mounts the
 * panel is a 5,900-line component, and a state change there per tick once made
 * a single hover take most of a second.
 */

/** One style edit: the diagram's new text and the block's theme, to land together. */
export type MermaidStyleEdit = { code: string; themeMode: MermaidThemeMode }

/**
 * How long a slider waits after its last movement before writing. A drag ends
 * in one `change` event; a held arrow key produces one per repeat, and each
 * write is an editor update, an undo step and a re-render of the diagram.
 */
export const MERMAID_SLIDER_COMMIT_DELAY_MS = 150

/** The option the Theme control shows when the text names a theme it cannot read. */
const THEME_SET_IN_TEXT = '__set-in-text'

/**
 * THE theme control, for the ribbon, the settings popover and this panel alike.
 *
 * It shows the theme the diagram is DRAWN in — the one its text names, when it
 * names one — rather than the block's stored theme, which is what it used to
 * show while the picture showed something else. It offers all eleven of
 * mermaid's themes, and writes a named one into the diagram's text.
 */
export const MermaidEffectiveThemeSelect: React.FunctionComponent<{
  code: string
  themeMode: MermaidThemeMode
  onApply: (edit: MermaidStyleEdit) => void
  /** The choice was not written; the reason is for the person. */
  onRefused: (refusal: MermaidConfigRefusal) => void
}> = ({ code, themeMode, onApply, onRefused }) => {
  const effective = readMermaidEffectiveTheme(readMermaidSourceConfig(code), themeMode)
  let value: string = THEME_SET_IN_TEXT
  if (effective.state === 'app') {
    value = 'app'
  } else if (effective.state === 'named') {
    value = effective.theme
  }
  return (
    <select
      className={MERMAID_SELECT_CLASS}
      value={value}
      aria-label="Diagram theme"
      title={describeMermaidThemeSource(effective)}
      onChange={(event) => {
        const choice = event.target.value
        if (choice === THEME_SET_IN_TEXT) {
          return
        }
        const edit = applyMermaidTheme(code, choice as 'app' | MermaidLibraryTheme)
        if (edit.ok) {
          onApply({ code: edit.code, themeMode: edit.themeMode })
        } else {
          onRefused(edit.refusal)
        }
      }}
    >
      {effective.state === 'unknown' ? (
        <option value={THEME_SET_IN_TEXT} disabled>
          Set in the diagram’s text
        </option>
      ) : null}
      <option value="app">{MERMAID_THEME_MODE_LABELS.app}</option>
      {MERMAID_LIBRARY_THEMES.map((theme) => (
        <option key={theme} value={theme}>
          {MERMAID_LIBRARY_THEME_LABELS[theme]}
        </option>
      ))}
    </select>
  )
}

/**
 * The button that opens this panel — the `customise` entry of the shared
 * control list, so the ribbon and the settings popover both carry it. It hands
 * its own element to the caller, which is what the panel is anchored to.
 */
export const MermaidCustomiseButton: React.FunctionComponent<{
  open: boolean
  onToggle: (anchor: HTMLElement) => void
  buttonRef?: React.Ref<HTMLButtonElement>
}> = ({ open, onToggle, buttonRef }) => (
  <button
    ref={buttonRef}
    type="button"
    className={
      'border-border flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ' +
      (open ? 'bg-info text-info-contrast' : 'hover:bg-contrast')
    }
    data-mermaid-customise-button="true"
    aria-label="Customise the diagram"
    title="Presets, themes, the hand-drawn look, text size, spacing and line style"
    onMouseDown={keepEditorFocus}
    onClick={(event) => onToggle(event.currentTarget)}
  >
    <Icon type="themes" size="small" />
    Customise…
  </button>
)

const ROW_CLASS = 'mt-2 flex items-start justify-between gap-2'
const LABEL_CLASS = 'text-passive-1 shrink-0 pt-0.5'
const HINT_CLASS = 'text-passive-1 mt-0.5 text-[0.7rem] leading-snug'

/** A control mermaid has no working option for, for this kind of diagram. */
const Unavailable: React.FunctionComponent<{ label: string; reason: string }> = ({ label, reason }) => (
  <div className={ROW_CLASS} data-mermaid-customise-row={label} data-mermaid-customise-unavailable="true">
    <span className={LABEL_CLASS}>{label}</span>
    <span className="text-passive-1 text-right text-[0.7rem] leading-snug">{reason}</span>
  </div>
)

/**
 * A range input that keeps its own draft while it moves and hands the value
 * over once, when the movement has stopped.
 *
 * The draft is what makes a drag cheap: every tick re-renders this input and
 * nothing above it. The native `change` event is what ends a movement — the
 * browser fires it when a drag is released, and once per key press — so that,
 * debounced, is the commit; React's own `onChange` is the per-tick `input`.
 */
const CommittedRange: React.FunctionComponent<{
  label: string
  min: number
  max: number
  step: number
  /** What the diagram's text holds now. */
  value: number
  describe: (value: number) => string
  /** Returns whether the value was written; a refusal puts the slider back. */
  onCommit: (value: number) => boolean
}> = ({ label, min, max, step, value, describe, onCommit }) => {
  const [draft, setDraft] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pending = useRef<number | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  // The text moved — this slider's own commit landing, an undo, a collaborator.
  // Whatever was being dragged towards is no longer relative to anything.
  useEffect(() => {
    setDraft(null)
  }, [value])

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    const next = pending.current
    pending.current = null
    if (next !== null && !commitRef.current(next)) {
      setDraft(null)
    }
  }, [])

  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    const onMovementEnded = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, MERMAID_SLIDER_COMMIT_DELAY_MS)
    }
    input.addEventListener('change', onMovementEnded)
    return () => {
      input.removeEventListener('change', onMovementEnded)
      // The panel closing must not lose a value the person had already let go of.
      flush()
    }
  }, [flush])

  const shown = draft ?? value
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="range"
        className="accent-info h-4 min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={label}
        aria-valuetext={describe(shown)}
        onChange={(event) => {
          const next = Number(event.target.value)
          pending.current = next
          setDraft(next)
        }}
        onBlur={flush}
      />
      <output className="text-passive-1 w-24 shrink-0 text-right text-[0.7rem] tabular-nums" aria-hidden="true">
        {describe(shown)}
      </output>
    </div>
  )
}

/** Where a slider sits: on the number the text holds, or at mermaid's default when it holds none it offers. */
function numberShown(reading: MermaidControlReading<number>, fallback: number): number {
  return reading.state === 'set' ? reading.value : fallback
}

/** The line under a control saying what the text holds that the control does not offer. */
function describeOther(reading: { state: string; description?: string }, quiet: boolean): string | null {
  return !quiet && reading.state === 'other' && reading.description !== undefined ? reading.description : null
}

/** The value a line-style select shows; empty for a style in the text that it does not list. */
function lineStyleShown(reading: MermaidControlReading<MermaidLineStyle>): string {
  if (reading.state === 'set') {
    return reading.value
  }
  return reading.state === 'default' ? DEFAULT_MERMAID_LINE_STYLE : ''
}

export type MermaidCustomisePanelProps = {
  /** The diagram's text. */
  code: string
  /** The block's stored theme. */
  themeMode: MermaidThemeMode
  /** The one way out: the diagram's new text and the block's theme, to be written together. */
  onApply: (edit: MermaidStyleEdit) => void
  /**
   * A refusal that happened outside the panel — a theme chosen on the ribbon
   * that could not be written — to be shown here, where the reason has room.
   */
  notice?: MermaidConfigRefusal
}

export const MermaidCustomisePanel: React.FunctionComponent<MermaidCustomisePanelProps> = ({
  code,
  themeMode,
  onApply,
  notice,
}) => {
  const [refused, setRefused] = useState<MermaidConfigRefusal | undefined>(notice)
  useEffect(() => {
    if (notice !== undefined) {
      setRefused(notice)
    }
  }, [notice])

  const reading = useMemo(() => readMermaidSourceConfig(code), [code])
  const kind = mermaidCustomiseKind(code)
  const effectiveTheme = readMermaidEffectiveTheme(reading, themeMode)
  const look = readMermaidLook(reading, kind)
  const textSize = readMermaidTextSize(reading, kind)
  const spacing = readMermaidSpacing(reading, kind)
  const lineStyle = readMermaidLineStyle(reading, kind)
  const activePreset = activeMermaidStylePreset(code, themeMode)
  const overrides = readMermaidDirectiveOverrides(reading)
  // One notice says it for the whole panel; the same reason under each of five
  // controls would only bury the controls.
  const frontmatterProblem =
    reading.frontmatter.state === 'unreadable' ? describeUnreadableFrontmatter(reading.frontmatter.refusal) : null
  const quiet = frontmatterProblem !== null || overrides?.unreadable === true

  /** Hand an edit on, or show why it was not made. Returns whether it was. */
  const commit = useCallback(
    (edit: MermaidCustomiseEdit): boolean => {
      if (!edit.ok) {
        setRefused(edit.refusal)
        return false
      }
      setRefused(undefined)
      if (edit.code !== code || edit.themeMode !== themeMode) {
        onApply({ code: edit.code, themeMode: edit.themeMode })
      }
      return true
    },
    [code, themeMode, onApply],
  )

  const presets = MERMAID_STYLE_PRESETS.map((preset) => ({
    preset,
    availability: mermaidStylePresetAvailability(preset.id, code),
  }))

  const sizeText = (size: number): string => {
    const described = describeMermaidTextSize(kind, size)
    return described === null ? `${size}` : `${described.percent}% · ${described.pixels}px`
  }

  return (
    <div
      className="text-xs"
      data-mermaid-customise="panel"
      role="group"
      aria-label="Customise the diagram"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">Customise</span>
        <span className="text-passive-1 text-[0.7rem]" data-mermaid-customise-kind={kind}>
          {mermaidKindPhrase(kind)}
        </span>
      </div>

      {refused !== undefined ? (
        <div
          className="border-danger bg-contrast text-foreground mt-2 rounded border p-2 leading-snug"
          role="alert"
          data-mermaid-customise-refusal={refused.code}
        >
          <div className="text-danger font-semibold">Not changed</div>
          <div>{refused.message}</div>
          <button
            type="button"
            className="border-border hover:bg-default mt-1 rounded border px-1.5 py-0.5"
            onMouseDown={keepEditorFocus}
            onClick={() => setRefused(undefined)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {frontmatterProblem !== null ? (
        <div
          className="border-warning bg-contrast mt-2 rounded border p-2 leading-snug"
          role="note"
          data-mermaid-customise-standing="frontmatter"
        >
          {frontmatterProblem} The controls below only write into a frontmatter they can keep exactly as it is, so they
          will leave this one alone; edit its options in the code.
        </div>
      ) : null}

      {overrides !== null ? (
        <div
          className="border-warning bg-contrast mt-2 rounded border p-2 leading-snug"
          role="note"
          data-mermaid-customise-standing="directive"
        >
          {overrides.unreadable
            ? `Line ${overrides.line} of the diagram’s text is an init directive this panel cannot read. A directive wins over anything chosen here, so a choice may appear to do nothing.`
            : `Line ${overrides.line} of the diagram’s text is an init directive that sets ${overrides.keys.join(
                ', ',
              )}. It wins over anything chosen here; edit that line to change ${
                overrides.keys.length === 1 ? 'it' : 'them'
              }.`}
        </div>
      ) : null}

      <div className="mt-2" role="group" aria-label="Presets">
        <div className="text-passive-1">Presets</div>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {presets.map(({ preset, availability }) => (
            <button
              key={preset.id}
              type="button"
              className={
                'border-border rounded border px-1 py-1 text-center disabled:opacity-50 ' +
                (activePreset === preset.id ? 'bg-info text-info-contrast' : 'hover:bg-contrast')
              }
              data-mermaid-preset={preset.id}
              aria-pressed={activePreset === preset.id}
              disabled={!availability.available}
              title={availability.available ? preset.description : availability.reason}
              onMouseDown={keepEditorFocus}
              onClick={() => commit(applyMermaidStylePreset(code, preset.id))}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {presets.map(({ preset, availability }) => {
          if (availability.available) {
            return null
          }
          return (
            <div key={preset.id} className={HINT_CLASS} data-mermaid-preset-unavailable={preset.id}>
              {availability.reason}
            </div>
          )
        })}
      </div>

      <div className={ROW_CLASS} data-mermaid-customise-row="Theme">
        <span className={LABEL_CLASS}>Theme</span>
        <div className="min-w-0 text-right">
          <MermaidEffectiveThemeSelect
            code={code}
            themeMode={themeMode}
            onApply={(edit) => {
              setRefused(undefined)
              onApply(edit)
            }}
            onRefused={setRefused}
          />
          <div className={HINT_CLASS} data-mermaid-theme-source={effectiveTheme.state}>
            {quiet && effectiveTheme.state === 'unknown'
              ? 'The diagram’s own text may name one.'
              : describeMermaidThemeSource(effectiveTheme)}
          </div>
        </div>
      </div>

      {look.state === 'unavailable' ? (
        <Unavailable label="Look" reason={look.reason} />
      ) : (
        <div className={ROW_CLASS} data-mermaid-customise-row="Look">
          <span className={LABEL_CLASS}>Look</span>
          <div className="min-w-0 text-right">
            <div className="flex items-center justify-end gap-1">
              <div className={MERMAID_GROUP_CLASS} role="group" aria-label="Diagram look">
                {MERMAID_LOOKS.map((candidate) => {
                  const active =
                    look.state === 'set'
                      ? look.value === candidate
                      : look.state === 'default' && candidate === 'classic'
                  return (
                    <button
                      key={candidate}
                      type="button"
                      className={mermaidSegmentClass(active)}
                      aria-pressed={active}
                      onMouseDown={keepEditorFocus}
                      onClick={() => commit(applyMermaidLook(code, themeMode, candidate))}
                    >
                      {MERMAID_LOOK_LABELS[candidate]}
                    </button>
                  )
                })}
              </div>
              {look.state === 'set' && look.value === 'handDrawn' ? (
                <button
                  type="button"
                  className="border-border hover:bg-contrast rounded border px-1.5 py-0.5"
                  title="Draw the same diagram with different strokes"
                  onMouseDown={keepEditorFocus}
                  onClick={() => commit(reshuffleMermaidSketch(code, themeMode))}
                >
                  Redraw
                </button>
              ) : null}
            </div>
            {describeOther(look, quiet) !== null ? (
              <div className={HINT_CLASS}>{describeOther(look, quiet)}</div>
            ) : null}
          </div>
        </div>
      )}

      {textSize.state === 'unavailable' ? (
        <Unavailable label="Text size" reason={textSize.reason} />
      ) : (
        <div className="mt-2" data-mermaid-customise-row="Text size">
          <div className="flex items-center justify-between gap-2">
            <span className="text-passive-1">Text size</span>
            <div className={MERMAID_GROUP_CLASS} role="group" aria-label="Text size">
              {MERMAID_TEXT_SIZE_STEPS.map((size) => {
                const active =
                  textSize.state === 'set'
                    ? textSize.value === size
                    : textSize.state === 'default' && size === DEFAULT_MERMAID_TEXT_SIZE
                return (
                  <button
                    key={size}
                    type="button"
                    className={mermaidSegmentClass(active)}
                    aria-pressed={active}
                    title={sizeText(size)}
                    onMouseDown={keepEditorFocus}
                    onClick={() => commit(applyMermaidTextSize(code, themeMode, size))}
                  >
                    {Math.round((size / DEFAULT_MERMAID_TEXT_SIZE) * 100)}%
                  </button>
                )
              })}
            </div>
          </div>
          <CommittedRange
            label="Text size, fine"
            min={MIN_MERMAID_TEXT_SIZE}
            max={MAX_MERMAID_TEXT_SIZE}
            step={1}
            value={numberShown(textSize, DEFAULT_MERMAID_TEXT_SIZE)}
            describe={sizeText}
            onCommit={(size) => commit(applyMermaidTextSize(code, themeMode, size))}
          />
          {describeOther(textSize, quiet) !== null ? (
            <div className={HINT_CLASS}>{describeOther(textSize, quiet)}</div>
          ) : null}
        </div>
      )}

      {spacing.state === 'unavailable' ? (
        <Unavailable label="Spacing" reason={spacing.reason} />
      ) : (
        <div className="mt-2" data-mermaid-customise-row="Spacing">
          <div className="flex items-center justify-between gap-2">
            <span className="text-passive-1">Spacing</span>
            <div className={MERMAID_GROUP_CLASS} role="group" aria-label="Spacing">
              {MERMAID_SPACING_LEVELS.map((level) => {
                const active =
                  spacing.state === 'set'
                    ? spacing.value === level.percent
                    : spacing.state === 'default' && level.percent === DEFAULT_MERMAID_SPACING
                return (
                  <button
                    key={level.label}
                    type="button"
                    className={mermaidSegmentClass(active)}
                    aria-pressed={active}
                    title={`${level.percent}% of mermaid’s own spacing`}
                    onMouseDown={keepEditorFocus}
                    onClick={() => commit(applyMermaidSpacing(code, themeMode, level.percent))}
                  >
                    {level.label}
                  </button>
                )
              })}
            </div>
          </div>
          <CommittedRange
            label="Spacing, fine"
            min={MIN_MERMAID_SPACING}
            max={MAX_MERMAID_SPACING}
            step={MERMAID_SPACING_STEP}
            value={numberShown(spacing, DEFAULT_MERMAID_SPACING)}
            describe={(percent) => `${percent}%`}
            onCommit={(percent) => commit(applyMermaidSpacing(code, themeMode, percent))}
          />
          {describeOther(spacing, quiet) !== null ? (
            <div className={HINT_CLASS}>{describeOther(spacing, quiet)}</div>
          ) : null}
        </div>
      )}

      {lineStyle.state === 'unavailable' ? (
        <Unavailable label="Line style" reason={lineStyle.reason} />
      ) : (
        <div className={ROW_CLASS} data-mermaid-customise-row="Line style">
          <span className={LABEL_CLASS}>Line style</span>
          <div className="min-w-0 text-right">
            <select
              className={MERMAID_SELECT_CLASS}
              value={lineStyleShown(lineStyle)}
              aria-label="Line style"
              onChange={(event) => {
                if (event.target.value !== '') {
                  commit(applyMermaidLineStyle(code, themeMode, event.target.value as MermaidLineStyle))
                }
              }}
            >
              {lineStyle.state === 'other' ? (
                <option value="" disabled>
                  Set in the diagram’s text
                </option>
              ) : null}
              {MERMAID_LINE_STYLES.map((style) => (
                <option key={style} value={style}>
                  {MERMAID_LINE_STYLE_LABELS[style]}
                </option>
              ))}
            </select>
            {describeOther(lineStyle, quiet) !== null ? (
              <div className={HINT_CLASS}>{describeOther(lineStyle, quiet)}</div>
            ) : null}
          </div>
        </div>
      )}

      <div className="border-border mt-3 flex items-start justify-between gap-2 border-t pt-2">
        <span className={HINT_CLASS + ' mt-0'}>
          Choices are written at the top of the diagram’s own text, so they travel with it.
        </span>
        <button
          type="button"
          className="border-border hover:bg-contrast shrink-0 rounded border px-1.5 py-0.5 disabled:opacity-50"
          data-mermaid-customise-reset="true"
          disabled={!mermaidCustomisationCanReset(code, themeMode)}
          title="Take every option this panel manages out of the diagram’s text, and follow the app’s theme"
          onMouseDown={keepEditorFocus}
          onClick={() => commit(resetMermaidCustomisation(code))}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
