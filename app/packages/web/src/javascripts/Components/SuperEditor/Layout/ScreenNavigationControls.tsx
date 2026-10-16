import { NoteLayout } from './layoutSettings'

/** Screen-only controls shared by the Layout ribbon; no editor mutations. */
export function ScreenNavigationControls({
  layout,
  onChange,
}: {
  layout: NoteLayout
  onChange: (patch: Partial<NoteLayout>) => void
}) {
  return (
    <fieldset className="border-border mt-3 flex flex-col gap-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Editor navigation</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={layout.lineNumbers}
          onChange={(event) => onChange({ lineNumbers: event.target.checked })}
        />
        Line numbers
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={layout.minimap}
          onChange={(event) => onChange({ minimap: event.target.checked })}
        />
        Minimap
      </label>
      <p className="text-passive-1 text-xs">
        Visual text lines on the left; document overview on the right. On-screen only.
      </p>
    </fieldset>
  )
}
