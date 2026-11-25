import { useEffect, useState } from 'react'
import { ApplicationEvent } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  EDITOR_VIEW_CHANGED,
  EDITOR_VIEW_DEFAULTS_KEY,
  EditorViewPreferences,
  normalizeEditorView,
  readEditorViewDefaults,
} from '@/View/editorViewPreferences'
import { EditorViewFields } from '@/Components/SuperEditor/View/EditorViewFields'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Title, Text } from '../../PreferencesComponents/Content'

export default function EditorViewDefaults() {
  const application = useApplication()
  const [value, setValue] = useState(() => readEditorViewDefaults(application))
  const [error, setError] = useState(false)
  useEffect(() => {
    const reload = () => setValue(readEditorViewDefaults(application))
    const remove = application.addEventObserver?.(async () => reload(), ApplicationEvent.PreferencesChanged)
    return () => {
      remove?.()
    }
  }, [application])
  const update = (patch: Partial<EditorViewPreferences>) => {
    const next = normalizeEditorView({ ...value, ...patch })
    setValue(next)
    void application
      .setPreference(EDITOR_VIEW_DEFAULTS_KEY, JSON.stringify(next))
      .then(() => {
        setError(false)
        window.dispatchEvent(new CustomEvent(EDITOR_VIEW_CHANGED))
      })
      .catch(() => setError(true))
  }
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Editor view defaults</Title>
        <Text>
          Choose the outline, comments and compact writing view. A note can save its own view from the View ribbon;
          those settings are encrypted and sync with the note.
        </Text>
        <div className="mt-4">
          <EditorViewFields value={value} onChange={update} />
        </div>
        {error && <p role="alert">View defaults could not be saved.</p>}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
