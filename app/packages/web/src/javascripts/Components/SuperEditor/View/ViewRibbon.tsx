import { useEffect, useSyncExternalStore } from 'react'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import { EditorViewFields } from './EditorViewFields'
import { useNoteViewPreferences } from './useNoteViewPreferences'
import { useEditorControlsState } from '../EditorControlsContext'
import { loadNoteLayout, saveNoteLayout, NOTE_LAYOUT_SETTINGS_CHANGED_EVENT } from '../Layout/layoutSettings'
import { RibbonGroup } from '../Plugins/ToolbarPlugin/RibbonGroup'
import { useApplication } from '@/Components/ApplicationProvider'
import { EDITOR_VIEW_DEFAULTS_KEY } from '@/View/editorViewPreferences'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { installChecklistBoxSizing } from './checklistBoxSizing'

export function NoteViewPreferencesBridge({ noteUuid }: { noteUuid?: string }) {
  const [editor] = useLexicalComposerContext()
  const application = useApplication()
  const editable = useLexicalEditable()
  const { settings, overrides } = useNoteViewPreferences(noteUuid, editable)
  const controls = useEditorControlsState()
  const defaultsConfigured = application.getPreference?.(EDITOR_VIEW_DEFAULTS_KEY, undefined) !== undefined
  useEffect(
    () =>
      installChecklistBoxSizing(editor, {
        checklistBoxSizing: settings.checklistBoxSizing,
        checklistBoxScale: settings.checklistBoxScale,
        checklistBoxSize: settings.checklistBoxSize,
      }),
    [editor, settings.checklistBoxSizing, settings.checklistBoxScale, settings.checklistBoxSize],
  )
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
      className="super-toolbar flex w-full min-w-0 flex-none flex-nowrap items-start gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1"
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
                window.dispatchEvent(new Event(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT))
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
