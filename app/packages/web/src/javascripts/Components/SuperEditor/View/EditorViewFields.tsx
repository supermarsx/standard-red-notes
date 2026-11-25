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
  ]
  if (ribbon) {
    return (
      <>
        {['Contents', 'Contents size', 'Panels and writing'].map((label, index) => (
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
