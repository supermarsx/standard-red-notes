import { useEffect, useState } from 'react'
import { Title, Text } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { PageLayoutFields } from '@/Components/SuperEditor/Layout/PageLayoutFields'
import {
  DEFAULT_NOTE_LAYOUT,
  loadLayoutDefaults,
  NOTE_LAYOUT_SETTINGS_CHANGED_EVENT,
  normalizeNoteLayout,
  NoteLayout,
  saveLayoutDefaults,
} from '@/Components/SuperEditor/Layout/layoutSettings'

export default function PageLayoutDefaults() {
  const [layout, setLayout] = useState(loadLayoutDefaults)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const reload = () => setLayout(loadLayoutDefaults())
    window.addEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
      window.removeEventListener('storage', reload)
    }
  }, [])
  const update = (patch: Partial<NoteLayout>) => {
    const next = normalizeNoteLayout({ ...layout, ...patch })
    setLayout(next)
    setFailed(!saveLayoutDefaults(next))
  }
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Page layout defaults</Title>
        <Text>
          Defaults for notes without a saved Layout override in this browser. Changing these does not replace existing
          per-note layouts. Use Layout → Page size → Reset note to defaults to apply them to a configured note.
        </Text>
        <Text>
          Print, DOCX and ODT support multiple columns. PDF exports currently require one column. Use physical margin
          units (mm, cm, in, pt, pc or px) for paginated exports.
        </Text>
        <div className="mt-4">
          <PageLayoutFields layout={layout} onChange={update} />
        </div>
        {failed && (
          <p role="alert" className="text-danger mt-2 text-sm">
            Layout defaults could not be saved in this browser.
          </p>
        )}
        <button type="button" className="text-info mt-4 text-sm underline" onClick={() => update(DEFAULT_NOTE_LAYOUT)}>
          Restore factory layout defaults
        </button>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
