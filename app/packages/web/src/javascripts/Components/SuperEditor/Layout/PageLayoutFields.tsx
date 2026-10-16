import { useEffect, useState, ReactNode } from 'react'
import {
  CUSTOM_MARGIN_ID,
  CUSTOM_PAGE_SIZE_ID,
  HEADER_FOOTER_ALIGNS,
  HEADER_FOOTER_FONTS,
  HeaderFooter,
  MAX_COLUMNS,
  MAX_HF_FONT_PT,
  MAX_PAGE_DIMENSION_MM,
  MAX_PAGE_START,
  MIN_HF_FONT_PT,
  MIN_PAGE_DIMENSION_MM,
  MARGIN_PRESETS,
  NoteLayout,
  PAGE_NUMBER_FORMATS,
  PAGE_SIZE_OPTIONS,
} from './layoutSettings'

const inputClass = 'border-border bg-default text-text min-w-0 rounded border px-2 py-1 text-sm'
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (value: string) => void
}) {
  return (
    <Field label={label}>
      <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  )
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

export function LayoutNumberField({
  label,
  value,
  min,
  max,
  onChange,
  optional = false,
}: {
  label: string
  value: number | undefined
  min: number
  max: number
  onChange: (value: number | undefined) => void
  optional?: boolean
}) {
  const [draft, setDraft] = useState(value?.toString() ?? '')
  const [error, setError] = useState(false)
  useEffect(() => {
    setDraft(value?.toString() ?? '')
    setError(false)
  }, [value])
  return (
    <Field label={label}>
      <input
        className={inputClass}
        type="number"
        min={min}
        max={max}
        step="any"
        value={draft}
        aria-invalid={error || undefined}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(false)
        }}
        onBlur={() => {
          if (optional && draft.trim() === '') {
            onChange(undefined)
            return
          }
          const number = Number(draft)
          if (!draft.trim() || !Number.isFinite(number) || number < min || number > max) {
            setError(true)
            return
          }
          onChange(number)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
      {error && (
        <span role="alert" className="text-danger text-xs">
          Enter a value from {min} to {max}.
        </span>
      )}
    </Field>
  )
}

export function CustomPageSizeFields({
  layout,
  onChange,
}: {
  layout: NoteLayout
  onChange: (patch: Partial<NoteLayout>) => void
}) {
  return (
    <div className="flex flex-col gap-2" onMouseDown={(event) => event.stopPropagation()}>
      <p className="text-passive-1 text-xs">
        Dimensions in millimetres, before orientation is applied ({MIN_PAGE_DIMENSION_MM}–{MAX_PAGE_DIMENSION_MM} mm).
      </p>
      <div className="grid grid-cols-2 gap-2">
        <LayoutNumberField
          label="Page width (mm)"
          value={layout.customPageWidthMm}
          min={MIN_PAGE_DIMENSION_MM}
          max={MAX_PAGE_DIMENSION_MM}
          onChange={(value) => onChange({ pageSizeId: CUSTOM_PAGE_SIZE_ID, customPageWidthMm: value })}
        />
        <LayoutNumberField
          label="Page height (mm)"
          value={layout.customPageHeightMm}
          min={MIN_PAGE_DIMENSION_MM}
          max={MAX_PAGE_DIMENSION_MM}
          onChange={(value) => onChange({ pageSizeId: CUSTOM_PAGE_SIZE_ID, customPageHeightMm: value })}
        />
      </div>
    </div>
  )
}

function BandFields({
  label,
  value,
  onChange,
}: {
  label: string
  value: HeaderFooter
  onChange: (patch: Partial<HeaderFooter>) => void
}) {
  return (
    <fieldset className="border-border flex flex-col gap-3 rounded border p-3">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <Toggle
        label={`Enable ${label.toLowerCase()}`}
        value={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      <Field label={`${label} text`}>
        <input
          type="text"
          className={inputClass}
          value={value.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </Field>
      <p className="text-passive-1 text-xs">
        Use {'{page}'} and {'{total}'} for page numbers.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Choice
          label={`${label} alignment`}
          value={value.align}
          options={HEADER_FOOTER_ALIGNS}
          onChange={(align) => onChange({ align: align as HeaderFooter['align'] })}
        />
        <Field label={`${label} font`}>
          <select
            className={inputClass}
            value={value.fontId ?? 'default'}
            onChange={(event) => onChange({ fontId: event.target.value as HeaderFooter['fontId'] })}
          >
            {HEADER_FOOTER_FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </Field>
        <LayoutNumberField
          label={`${label} font size (pt, blank = automatic)`}
          value={value.fontSizePt}
          min={MIN_HF_FONT_PT}
          max={MAX_HF_FONT_PT}
          optional
          onChange={(fontSizePt) => onChange({ fontSizePt })}
        />
        <Field label={`${label} color`}>
          <span className="flex gap-2">
            <input
              type="color"
              aria-label={`${label} color`}
              value={value.color ?? '#000000'}
              onChange={(event) => onChange({ color: event.target.value })}
            />
            <button
              type="button"
              className="text-info text-xs underline"
              onClick={() => onChange({ color: undefined })}
            >
              Automatic
            </button>
          </span>
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        {(['bold', 'italic', 'underline'] as const).map((style) => (
          <Toggle
            key={style}
            label={`${label} ${style}`}
            value={value[style] === true}
            onChange={(enabled) => onChange({ [style]: enabled })}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** The complete local layout contract, shared by the discoverable defaults UI. */
export function PageLayoutFields({
  layout,
  onChange,
}: {
  layout: NoteLayout
  onChange: (patch: Partial<NoteLayout>) => void
}) {
  const band = (key: 'header' | 'footer', patch: Partial<HeaderFooter>) =>
    onChange({ [key]: { ...layout[key], ...patch } })
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Page size">
          <select
            className={inputClass}
            value={layout.pageSizeId}
            onChange={(event) => onChange({ pageSizeId: event.target.value })}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_PAGE_SIZE_ID}>Custom</option>
          </select>
        </Field>
        <Choice
          label="Orientation"
          value={layout.orientation}
          options={['portrait', 'landscape']}
          onChange={(orientation) => onChange({ orientation: orientation as NoteLayout['orientation'] })}
        />
      </div>
      {layout.pageSizeId === CUSTOM_PAGE_SIZE_ID && <CustomPageSizeFields layout={layout} onChange={onChange} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Margins">
          <select
            className={inputClass}
            value={layout.marginId}
            onChange={(event) => onChange({ marginId: event.target.value })}
          >
            {MARGIN_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM_MARGIN_ID}>Custom</option>
          </select>
        </Field>
        <LayoutNumberField
          label="Text columns"
          value={layout.columns}
          min={1}
          max={MAX_COLUMNS}
          onChange={(columns) => onChange({ columns })}
        />
      </div>
      {layout.marginId === CUSTOM_MARGIN_ID && (
        <Field label="Custom margin (CSS length, e.g. 15mm)">
          <input
            className={inputClass}
            value={layout.customMargin}
            onChange={(event) => onChange({ customMargin: event.target.value })}
          />
        </Field>
      )}
      <fieldset className="border-border flex flex-col gap-3 rounded border p-3">
        <legend className="px-1 text-sm font-semibold">Page numbering</legend>
        <Toggle
          label="Enable page numbering"
          value={layout.pageNumbering.enabled}
          onChange={(enabled) => onChange({ pageNumbering: { ...layout.pageNumbering, enabled } })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Choice
            label="Number format"
            value={layout.pageNumbering.format}
            options={PAGE_NUMBER_FORMATS}
            onChange={(format) =>
              onChange({
                pageNumbering: { ...layout.pageNumbering, format: format as NoteLayout['pageNumbering']['format'] },
              })
            }
          />
          <Choice
            label="Number location"
            value={layout.pageNumbering.location}
            options={['header', 'footer']}
            onChange={(location) =>
              onChange({ pageNumbering: { ...layout.pageNumbering, location: location as 'header' | 'footer' } })
            }
          />
          <Choice
            label="Number alignment"
            value={layout.pageNumbering.align}
            options={HEADER_FOOTER_ALIGNS}
            onChange={(align) =>
              onChange({ pageNumbering: { ...layout.pageNumbering, align: align as HeaderFooter['align'] } })
            }
          />
          <LayoutNumberField
            label="Start at page"
            value={layout.pageNumbering.startAt}
            min={1}
            max={MAX_PAGE_START}
            onChange={(startAt) => onChange({ pageNumbering: { ...layout.pageNumbering, startAt: startAt ?? 1 } })}
          />
        </div>
      </fieldset>
      <BandFields label="Header" value={layout.header} onChange={(patch) => band('header', patch)} />
      <BandFields label="Footer" value={layout.footer} onChange={(patch) => band('footer', patch)} />
      <fieldset className="border-border flex flex-col gap-2 rounded border p-3">
        <legend className="px-1 text-sm font-semibold">On-screen navigation</legend>
        <Toggle
          label="Show document outline"
          value={layout.navigation.visible}
          onChange={(visible) => onChange({ navigation: { ...layout.navigation, visible } })}
        />
        <Toggle
          label="Show bookmarks in outline"
          value={layout.navigation.showBookmarks}
          onChange={(showBookmarks) => onChange({ navigation: { ...layout.navigation, showBookmarks } })}
        />
      </fieldset>
    </div>
  )
}
