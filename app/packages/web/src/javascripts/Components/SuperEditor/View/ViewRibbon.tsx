import { useEffect, useSyncExternalStore } from 'react'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import { EditorViewFields } from './EditorViewFields'
import { useNoteViewPreferences } from './useNoteViewPreferences'
import { useEditorControlsState } from '../EditorControlsContext'
import { loadNoteLayout, saveNoteLayout } from '../Layout/layoutSettings'
import { RibbonGroup } from '../Plugins/ToolbarPlugin/RibbonGroup'
import { useApplication } from '@/Components/ApplicationProvider'
import { EDITOR_VIEW_DEFAULTS_KEY } from '@/View/editorViewPreferences'

export function NoteViewPreferencesBridge({ noteUuid }: { noteUuid?: string }) {
  const application = useApplication()
  const editable = useLexicalEditable()
  const { settings, overrides } = useNoteViewPreferences(noteUuid, editable)
  const controls = useEditorControlsState()
  const defaultsConfigured = application.getPreference?.(EDITOR_VIEW_DEFAULTS_KEY, undefined) !== undefined
  useEffect(() => {
    if (defaultsConfigured || overrides.commentsVisible !== undefined || settings.commentsVisible) {
      controls.setCommentsLayout({ commentsOpen: settings.commentsVisible })
    }
  }, [controls, defaultsConfigured, overrides.commentsVisible, settings.commentsVisible])
  return null
}
export default function ViewRibbon({ noteUuid }: { noteUuid?: string }) {
  const editable = useLexicalEditable()
  const { settings, update, error } = useNoteViewPreferences(noteUuid, editable)
  const controls = useEditorControlsState()
  const state = useSyncExternalStore(controls.subscribe, controls.getSnapshot)
  const layout = loadNoteLayout(noteUuid)
  return (
    <div
      role="toolbar"
      aria-label="View tools"
      className="super-toolbar flex w-full flex-wrap items-start gap-1.5 px-1 py-1"
    >
      <EditorViewFields
        ribbon
        value={{ ...settings, commentsVisible: state.commentsOpen }}
        onChange={(patch) => {
          if (patch.commentsVisible !== undefined) {
            controls.setCommentsLayout({ commentsOpen: patch.commentsVisible })
          }
          update(patch)
        }}
      />
      <RibbonGroup label="Reading aids">
        {(['lineNumbers', 'minimap'] as const).map((key) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={layout[key]}
              onChange={(event) => {
                saveNoteLayout(noteUuid, { ...loadNoteLayout(noteUuid), [key]: event.target.checked })
              }}
            />
            {key === 'lineNumbers' ? 'Line numbers' : 'Document minimap'}
          </label>
        ))}
      </RibbonGroup>
      {!editable && <p className="text-passive-1 w-full text-xs">View changes apply to this open read-only note.</p>}
      {error && (
        <p role="alert" className="text-danger w-full text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
