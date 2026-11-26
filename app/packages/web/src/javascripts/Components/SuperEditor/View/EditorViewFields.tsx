import { EditorViewPreferences } from '@/View/editorViewPreferences'
import { Fragment } from 'react'
import { RibbonGroup } from '../Plugins/ToolbarPlugin/RibbonGroup'

export function EditorViewFields({
  value,
  onChange,
  ribbon = false,
}: {
  value: EditorViewPreferences
  onChange: (patch: Partial<EditorViewPreferences>) => void
  ribbon?: boolean
}) {
  const check = (
    key: 'tocVisible' | 'tocToggle' | 'bookmarks' | 'commentsVisible' | 'compactTitle' | 'compactTabs',
    label: string,
  ) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value[key]} onChange={(event) => onChange({ [key]: event.target.checked })} />
      {label}
    </label>
  )
  const fields = [
    check('tocVisible', 'Show table of contents'),
    check('tocToggle', 'Floating right contents toggle'),
    <label className={ribbon ? 'flex items-center justify-between gap-2 text-xs' : 'flex flex-col gap-1 text-sm'}>
      {ribbon ? 'Placement' : 'Contents placement'}
      <select
        className="border-border bg-default text-text rounded border px-2 py-1"
        value={value.tocMode}
        onChange={(event) => onChange({ tocMode: event.target.value as EditorViewPreferences['tocMode'] })}
      >
        <option value="right">Right sidebar</option>
        <option value="left">Left sidebar</option>
        <option value="floating">Floating popup</option>
      </select>
    </label>,
    check('bookmarks', 'Include bookmarks'),
    ...(['tocWidth', 'tocHeight'] as const).map((key) => (
      <label key={key} className="flex items-center justify-between gap-2 text-xs">
        {key === 'tocWidth' ? 'Contents width' : ribbon ? 'Popup height' : 'Floating contents height'}
        <input
          className="border-border bg-default text-text w-20 rounded border px-2 py-1"
          type="number"
          min={key === 'tocWidth' ? 200 : 160}
          max={key === 'tocWidth' ? 600 : 900}
          value={value[key]}
          onChange={(event) => {
            if (event.target.value !== '') {
              onChange({ [key]: Number(event.target.value) })
            }
          }}
        />
      </label>
    )),
    check('commentsVisible', 'Show comments panel'),
    check('compactTitle', 'Compact title while writing'),
    check('compactTabs', 'Compact note tabs while writing'),
    <label className="flex items-center justify-between gap-2 text-xs">
      Checklist box sizing
      <select
        className="border-border bg-default text-text rounded border px-1 py-0.5"
        value={value.checklistBoxSizing}
        onChange={(event) => onChange({ checklistBoxSizing: event.target.value as 'font' | 'fixed' })}
      >
        <option value="font">Match item font</option>
        <option value="fixed">Fixed size</option>
      </select>
    </label>,
    <label className="flex items-center justify-between gap-2 text-xs">
      Box scale (%)
      <input
        type="number"
        min={50}
        max={200}
        step={5}
        disabled={value.checklistBoxSizing !== 'font'}
        className="border-border bg-default text-text w-20 rounded border px-2 py-1 disabled:opacity-40"
        value={value.checklistBoxScale}
        onChange={(event) => event.target.value && onChange({ checklistBoxScale: Number(event.target.value) })}
      />
    </label>,
    <label className="flex items-center justify-between gap-2 text-xs">
      Fixed box size (px)
      <input
        type="number"
        min={10}
        max={64}
        disabled={value.checklistBoxSizing !== 'fixed'}
        className="border-border bg-default text-text w-20 rounded border px-2 py-1 disabled:opacity-40"
        value={value.checklistBoxSize}
        onChange={(event) => event.target.value && onChange({ checklistBoxSize: Number(event.target.value) })}
      />
    </label>,
  ]
  if (ribbon) {
    return (
      <>
        {['Contents', 'Contents size', 'Panels and writing', 'Checklist boxes'].map((label, index) => (
          <RibbonGroup key={label} label={label}>
            {fields.slice(index * 3, index * 3 + 3).map((field, position) => (
              <Fragment key={position}>{field}</Fragment>
            ))}
          </RibbonGroup>
        ))}
      </>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {fields.map((field, index) => (
        <Fragment key={index}>{field}</Fragment>
      ))}
    </div>
  )
}
