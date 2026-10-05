import * as React from 'react'
import { useCallback } from 'react'
import Icon from '@/Components/Icon/Icon'
import { MermaidWidthSection } from './MermaidBlockControls'
import {
  MERMAID_ALIGNMENT_LABELS,
  MERMAID_ALIGNMENTS,
  MERMAID_BACKGROUND_LABELS,
  MERMAID_FIT_MODE_LABELS,
  MERMAID_FIT_MODES,
  MERMAID_MAX_HEIGHT_NONE,
  MERMAID_THEME_MODE_LABELS,
  MERMAID_THEME_MODES,
  MERMAID_VIEW_MODES,
  MermaidAlignment,
  MermaidBackground,
  MermaidFitMode,
  MermaidMaxHeight,
  MermaidSettings,
  MermaidThemeMode,
  MermaidViewMode,
  MAX_MERMAID_MAX_HEIGHT_PX,
  MIN_MERMAID_MAX_HEIGHT_PX,
  normalizeMermaidMaxHeight,
} from './MermaidSettings'

/**
 * Standard Red Notes — the Mermaid diagram's configuration controls.
 *
 * Each control is ONE exported component, and the surface that exposes mermaid
 * configuration mounts those same components:
 *
 *   - the editor toolbar's dedicated "Mermaid" contextual section — the clusters
 *     directly inside its captioned segments, plus this same panel with
 *     `variant: 'panel'` inside its settings popover (ToolbarPlugin).
 *
 * `variant: 'bar'` is the OTHER arrangement, the one the chart container used to
 * mount on its own top bar. t119 unmounted that surface — the user asked not to
 * be offered the same controls twice — and this file deliberately kept it: the
 * control LIST is the single ordered `mermaidSettingsControls` either way, both
 * arrangements are still built and still tested, so restoring the chart surface,
 * or a chosen subset of it, is a matter of mounting this component again. What
 * must never come back is a second, hand-written copy of a control.
 *
 * Mirrored, never forked. There is no per-surface copy of a control's markup, its
 * labels or its write rule: the labels come from MermaidSettings.ts, the write is
 * the caller's `onChange`, and the panel itself is assembled from the very same
 * exported clusters the toolbar's inline segments use.
 *
 * Pure: state arrives as props, every change leaves as a callback. Nothing here
 * touches the editor, the application or a preference store, so the whole render
 * path is exercisable directly in jsdom (the `ChecklistSubsection` model).
 *
 * The WIDTH control is not reimplemented: it delegates to the existing
 * `MermaidWidthSection`, so the width field, its presets and its validation keep
 * exactly one implementation.
 */

/** Alignment glyph names, mapped explicitly so no unmapped icon name can leak. */
const ALIGNMENT_ICONS: Record<MermaidAlignment, 'align-left' | 'align-center' | 'align-right'> = {
  left: 'align-left',
  center: 'align-center',
  right: 'align-right',
}

const SELECT_CLASS =
  'rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'
const GROUP_CLASS = 'border-border flex overflow-hidden rounded border text-xs'

const segmentClass = (active: boolean) =>
  'px-1.5 py-0.5 ' + (active ? 'bg-info text-info-contrast' : 'hover:bg-contrast')

/** Keeps the caret in the editor when a control inside the toolbar is clicked. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

/** Whether the mermaid SOURCE is shown beside the diagram, and in what form. */
export const MermaidViewModeGroup: React.FunctionComponent<{
  viewMode: MermaidViewMode
  onChange: (next: MermaidViewMode) => void
}> = ({ viewMode, onChange }) => (
  <div className={GROUP_CLASS} role="group" aria-label="View mode">
    {MERMAID_VIEW_MODES.map((mode) => (
      <button
        key={mode}
        type="button"
        className={segmentClass(viewMode === mode) + ' capitalize'}
        aria-pressed={viewMode === mode}
        onMouseDown={keepFocus}
        onClick={() => onChange(mode)}
      >
        {mode}
      </button>
    ))}
  </div>
)

/** How the diagram is fitted to its container. */
export const MermaidFitModeGroup: React.FunctionComponent<{
  fitMode: MermaidFitMode
  onChange: (next: MermaidFitMode) => void
}> = ({ fitMode, onChange }) => (
  <div className={GROUP_CLASS} role="group" aria-label="Fit mode">
    {MERMAID_FIT_MODES.map((mode) => (
      <button
        key={mode}
        type="button"
        className={segmentClass(fitMode === mode)}
        aria-pressed={fitMode === mode}
        title={MERMAID_FIT_MODE_LABELS[mode]}
        onMouseDown={keepFocus}
        onClick={() => onChange(mode)}
      >
        {MERMAID_FIT_MODE_LABELS[mode]}
      </button>
    ))}
  </div>
)

/** Where a block narrower than the note column sits within it. */
export const MermaidAlignmentGroup: React.FunctionComponent<{
  alignment: MermaidAlignment
  onChange: (next: MermaidAlignment) => void
}> = ({ alignment, onChange }) => (
  <div className={GROUP_CLASS} role="group" aria-label="Diagram alignment">
    {MERMAID_ALIGNMENTS.map((candidate) => (
      <button
        key={candidate}
        type="button"
        className={'flex px-1.5 py-1 ' + (alignment === candidate ? 'bg-info text-info-contrast' : 'hover:bg-contrast')}
        aria-pressed={alignment === candidate}
        aria-label={MERMAID_ALIGNMENT_LABELS[candidate]}
        title={MERMAID_ALIGNMENT_LABELS[candidate]}
        onMouseDown={keepFocus}
        onClick={() => onChange(candidate)}
      >
        <Icon type={ALIGNMENT_ICONS[candidate]} size="small" />
      </button>
    ))}
  </div>
)

/** The diagram's theme, including "follow the application's theme". */
export const MermaidThemeSelect: React.FunctionComponent<{
  themeMode: MermaidThemeMode
  onChange: (next: MermaidThemeMode) => void
}> = ({ themeMode, onChange }) => (
  <select
    className={SELECT_CLASS}
    value={themeMode}
    aria-label="Diagram theme"
    onChange={(event) => onChange(event.target.value as MermaidThemeMode)}
  >
    {MERMAID_THEME_MODES.map((mode) => (
      <option key={mode} value={mode}>
        {MERMAID_THEME_MODE_LABELS[mode]}
      </option>
    ))}
  </select>
)

/** How the maximum-height setting is being expressed. */
export type MermaidMaxHeightMode = 'window' | 'none' | 'fixed'

export function mermaidMaxHeightModeOf(maxHeight: MermaidMaxHeight | undefined): MermaidMaxHeightMode {
  if (maxHeight === MERMAID_MAX_HEIGHT_NONE) {
    return 'none'
  }
  return typeof maxHeight === 'number' ? 'fixed' : 'window'
}

export const MERMAID_MAX_HEIGHT_MODE_LABELS: Record<MermaidMaxHeightMode, string> = {
  window: 'Follow window',
  none: 'No limit',
  fixed: 'Fixed',
}

/** A fixed maximum to pre-fill with when the user switches to "Fixed". */
export const SUGGESTED_FIXED_MERMAID_MAX_HEIGHT_PX = 600

/**
 * The ceiling on the preview box's height — the configurable maximum that
 * replaced the hardcoded 480. "Follow window" is the default; "No limit" is what
 * makes a width-fit span the container at any aspect ratio.
 */
export const MermaidMaxHeightControl: React.FunctionComponent<{
  maxHeight: MermaidMaxHeight | undefined
  onChange: (next: MermaidMaxHeight | undefined) => void
}> = ({ maxHeight, onChange }) => {
  const mode = mermaidMaxHeightModeOf(maxHeight)
  const setMode = useCallback(
    (next: MermaidMaxHeightMode) => {
      if (next === 'none') {
        onChange(MERMAID_MAX_HEIGHT_NONE)
      } else if (next === 'fixed') {
        onChange(SUGGESTED_FIXED_MERMAID_MAX_HEIGHT_PX)
      } else {
        onChange(undefined)
      }
    },
    [onChange],
  )

  return (
    <div className="flex items-center gap-1">
      <select
        className={SELECT_CLASS}
        value={mode}
        aria-label="Maximum diagram height"
        onChange={(event) => setMode(event.target.value as MermaidMaxHeightMode)}
      >
        {(['window', 'none', 'fixed'] as MermaidMaxHeightMode[]).map((candidate) => (
          <option key={candidate} value={candidate}>
            {MERMAID_MAX_HEIGHT_MODE_LABELS[candidate]}
          </option>
        ))}
      </select>
      {mode === 'fixed' ? (
        <input
          type="number"
          className="border-border bg-default text-foreground focus:border-info w-20 rounded border px-1 py-0.5 outline-none"
          min={MIN_MERMAID_MAX_HEIGHT_PX}
          max={MAX_MERMAID_MAX_HEIGHT_PX}
          step={20}
          value={typeof maxHeight === 'number' ? maxHeight : SUGGESTED_FIXED_MERMAID_MAX_HEIGHT_PX}
          aria-label="Maximum diagram height in pixels"
          onChange={(event) => {
            const parsed = normalizeMermaidMaxHeight(event.target.value)
            if (parsed !== undefined) {
              onChange(parsed)
            }
          }}
        />
      ) : null}
    </div>
  )
}

/** Whether the preview box paints the editor's own surface behind the diagram. */
export const MermaidBackgroundToggle: React.FunctionComponent<{
  background: MermaidBackground
  onChange: (next: MermaidBackground) => void
}> = ({ background, onChange }) => (
  <button
    type="button"
    className={
      'border-border rounded border px-1.5 py-0.5 text-xs ' +
      (background === 'themed' ? 'bg-info text-info-contrast' : 'hover:bg-contrast')
    }
    aria-pressed={background === 'themed'}
    aria-label="Themed diagram background"
    onMouseDown={keepFocus}
    onClick={() => onChange(background === 'themed' ? 'transparent' : 'themed')}
    title="Paint the editor's own surface colour behind the diagram"
  >
    {MERMAID_BACKGROUND_LABELS[background]}
  </button>
)

/** Wheel-zoom / drag-pan / pinch, and the zoom cluster over the diagram. */
export const MermaidZoomPanToggle: React.FunctionComponent<{
  zoomPan: boolean
  onChange: (next: boolean) => void
}> = ({ zoomPan, onChange }) => (
  <button
    type="button"
    className={
      'border-border rounded border px-1.5 py-0.5 text-xs ' +
      (zoomPan ? 'bg-info text-info-contrast' : 'hover:bg-contrast')
    }
    aria-pressed={zoomPan}
    aria-label="Pan and zoom over the diagram"
    onMouseDown={keepFocus}
    onClick={() => onChange(!zoomPan)}
    title="Wheel-zoom, drag-pan and the zoom controls over the diagram"
  >
    {zoomPan ? 'On' : 'Off'}
  </button>
)

export type MermaidSettingsPanelProps = {
  /** Arrangement only — never which controls exist. */
  variant: 'bar' | 'panel'
  /** The node's resolved settings. */
  settings: MermaidSettings
  /** Applies a partial change to the node. */
  onSettingsChange: (patch: Partial<MermaidSettings>) => void
  /** The split-pane view mode, i.e. whether the source is shown. */
  viewMode: MermaidViewMode
  onViewModeChange: (next: MermaidViewMode) => void
  /** The block's stored width, already normalized, or undefined for "fit". */
  width: string | undefined
  onWidthChange: (next: string | undefined) => void
  /** The stored preview-box height (px), or undefined for "auto-fit". */
  height: number | undefined
  onHeightChange: (next: number | undefined) => void
  /**
   * Whether the width strip renders. The mount point decides; the toolbar surface
   * passes true, because reaching the Mermaid section already requires a selected
   * diagram. (It is a prop at all because the chart surface used to gate it on its
   * own selection state.)
   */
  showWidth: boolean
}

/**
 * THE control set, in order. Shared by both variants, so neither can be missing
 * one. Exported so the toolbar's captioned segments can be built from the exact
 * same list rather than a second hand-written one.
 */
export function mermaidSettingsControls(props: MermaidSettingsPanelProps): {
  key: string
  caption: string
  node: React.ReactNode
}[] {
  const { settings, onSettingsChange, viewMode, onViewModeChange } = props
  return [
    {
      key: 'source',
      caption: 'Source',
      node: <MermaidViewModeGroup viewMode={viewMode} onChange={onViewModeChange} />,
    },
    {
      key: 'fit',
      caption: 'Fit',
      node: <MermaidFitModeGroup fitMode={settings.fitMode} onChange={(fitMode) => onSettingsChange({ fitMode })} />,
    },
    {
      key: 'maxHeight',
      caption: 'Max height',
      node: (
        <MermaidMaxHeightControl
          maxHeight={settings.maxHeight}
          onChange={(maxHeight) => onSettingsChange({ maxHeight })}
        />
      ),
    },
    {
      key: 'alignment',
      caption: 'Align',
      node: (
        <MermaidAlignmentGroup
          alignment={settings.alignment}
          onChange={(alignment) => onSettingsChange({ alignment })}
        />
      ),
    },
    {
      key: 'theme',
      caption: 'Theme',
      node: (
        <MermaidThemeSelect themeMode={settings.themeMode} onChange={(themeMode) => onSettingsChange({ themeMode })} />
      ),
    },
    {
      key: 'background',
      caption: 'Background',
      node: (
        <MermaidBackgroundToggle
          background={settings.background}
          onChange={(background) => onSettingsChange({ background })}
        />
      ),
    },
    {
      key: 'zoomPan',
      caption: 'Pan & zoom',
      node: <MermaidZoomPanToggle zoomPan={settings.zoomPan} onChange={(zoomPan) => onSettingsChange({ zoomPan })} />,
    },
  ]
}

export const MermaidSettingsPanel: React.FunctionComponent<MermaidSettingsPanelProps> = (props) => {
  const { variant, width, onWidthChange, height, onHeightChange, showWidth } = props
  const controls = mermaidSettingsControls(props)

  const widthSection = (
    <MermaidWidthSection
      visible={showWidth}
      width={width}
      onWidthChange={onWidthChange}
      height={height}
      onHeightChange={onHeightChange}
    />
  )

  if (variant === 'bar') {
    return (
      <div data-mermaid-settings="bar" onClick={(event) => event.stopPropagation()}>
        <div className="text-passive-1 flex flex-wrap items-center gap-2 text-xs">
          {controls.map((control) => (
            <label key={control.key} className="flex items-center gap-1">
              {control.caption}
              {control.node}
            </label>
          ))}
        </div>
        {widthSection}
      </div>
    )
  }

  return (
    <div className="text-xs" data-mermaid-settings="panel" onClick={(event) => event.stopPropagation()}>
      {controls.map((control) => (
        <div key={control.key} className="mt-2 flex items-center justify-between gap-2 first:mt-0">
          <span className="text-passive-1">{control.caption}</span>
          {control.node}
        </div>
      ))}
      <div className="mt-2">{widthSection}</div>
    </div>
  )
}
