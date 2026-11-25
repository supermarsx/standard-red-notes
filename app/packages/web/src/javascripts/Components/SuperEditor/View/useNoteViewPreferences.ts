import { useCallback, useEffect, useRef, useState } from 'react'
import { useApplication } from '@/Components/ApplicationProvider'
import { ApplicationEvent, SNNote } from '@standardnotes/snjs'
import {
  EDITOR_VIEW_CHANGED,
  EditorViewPreferences,
  normalizeEditorView,
  normalizeViewOverrides,
  noteViewOverrides,
  readEditorViewDefaults,
} from '@/View/editorViewPreferences'
import { loadNoteLayout, NOTE_LAYOUT_SETTINGS_CHANGED_EVENT } from '../Layout/layoutSettings'

export function useNoteViewPreferences(noteUuid: string | undefined, writable: boolean) {
  const application = useApplication()
  const read = useCallback(() => {
    const note = noteUuid ? application.items.findItem<SNNote>(noteUuid) : undefined
    const legacy = loadNoteLayout(noteUuid).navigation
    const overrides = noteViewOverrides(note)
    return {
      overrides,
      settings: normalizeEditorView({
        ...readEditorViewDefaults(application),
        ...(legacy.visible ? { tocVisible: true } : {}),
        ...(!legacy.showBookmarks ? { bookmarks: false } : {}),
        ...overrides,
      }),
    }
  }, [application, noteUuid])
  const [snapshot, setSnapshot] = useState(read)
  const latest = useRef(snapshot)
  const [error, setError] = useState('')
  useEffect(() => {
    const publish = (value: typeof snapshot) => {
      latest.current = value
      setSnapshot(value)
    }
    const reload = () => publish(read())
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ noteUuid?: string; overrides?: unknown }>).detail
      if (detail?.noteUuid === noteUuid && detail.overrides) {
        const overrides = normalizeViewOverrides(detail.overrides)
        publish({ overrides, settings: normalizeEditorView({ ...read().settings, ...overrides }) })
      } else if (!detail?.noteUuid) {
        reload()
      }
    }
    reload()
    window.addEventListener(EDITOR_VIEW_CHANGED, changed)
    window.addEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
    const stop = application.addEventObserver?.(async () => reload(), ApplicationEvent.PreferencesChanged)
    const stopItems = application.items.addObserver?.(['Note'], ({ changed: changedItems, inserted, unerrored }) => {
      if ([...changedItems, ...inserted, ...unerrored].some((item) => item.uuid === noteUuid)) {
        reload()
      }
    })
    return () => {
      window.removeEventListener(EDITOR_VIEW_CHANGED, changed)
      window.removeEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
      stop?.()
      stopItems?.()
    }
  }, [application, noteUuid, read])
  const update = useCallback(
    (patch: Partial<EditorViewPreferences>) => {
      const overrides = normalizeViewOverrides({ ...latest.current.overrides, ...patch })
      latest.current = { overrides, settings: normalizeEditorView({ ...latest.current.settings, ...overrides }) }
      setSnapshot(latest.current)
      window.dispatchEvent(new CustomEvent(EDITOR_VIEW_CHANGED, { detail: { noteUuid, overrides } }))
      const note = noteUuid ? application.items.findItem<SNNote>(noteUuid) : undefined
      if (writable && note && !note.locked && application.notesController?.patchNoteViewPreferences) {
        void application.notesController
          .patchNoteViewPreferences(note, patch)
          .then(() => setError(''))
          .catch(() => setError('The view is available, but its settings could not be saved to this note.'))
      }
    },
    [application, noteUuid, writable],
  )
  return { ...snapshot, update, error }
}
