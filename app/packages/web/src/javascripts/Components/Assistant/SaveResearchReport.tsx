import { NoteType } from '@standardnotes/features'
import { useRef, useState } from 'react'
import type { WebApplication } from '@/Application/WebApplication'
import { researchReportTargets, saveResearchReport } from '@/Assistant/saveResearchReport'
import Button from '../Button/Button'

/** Explicit, deterministic save of completed findings; rendering never creates a note. */
export default function SaveResearchReport({
  application,
  report,
  reportId,
  onSaved,
}: {
  application: WebApplication
  report: string
  reportId: string
  onSaved?: (noteUuid: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [target, setTarget] = useState('new')
  const [title, setTitle] = useState('Research findings')
  const [notes, setNotes] = useState(() => researchReportTargets(application))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const inFlight = useRef(false)
  const appendTooLarge =
    report.length > 16384 && notes.some((note) => note.uuid === target && note.noteType === NoteType.Super)
  const save = async () => {
    if (inFlight.current || appendTooLarge) {
      return
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const noteUuid = await saveResearchReport(application, {
        report,
        reportId,
        target: target === 'new' ? { kind: 'new', title } : { kind: 'existing', noteUuid: target },
      })
      setSaved(true)
      setExpanded(false)
      onSaved?.(noteUuid)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The findings could not be saved. Try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  if (saved) {
    return (
      <p role="status" className="text-passive-1 text-xs">
        Findings saved to your note.
      </p>
    )
  }
  return (
    <div className="border-border text-default mt-2 rounded border p-2 text-xs">
      {!expanded ? (
        <button
          type="button"
          className="text-info"
          onClick={() => {
            setNotes(researchReportTargets(application))
            setExpanded(true)
          }}
        >
          Save findings to a note…
        </button>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label>
              Destination{' '}
              <select
                aria-label="Findings destination"
                value={target}
                disabled={busy}
                onChange={(event) => setTarget(event.target.value)}
                className="border-border bg-default text-default rounded border px-2 py-1"
              >
                <option value="new">New note</option>
                {notes.map((note) => (
                  <option key={note.uuid} value={note.uuid}>
                    {note.title || 'Untitled note'}
                  </option>
                ))}
              </select>
            </label>
            {target === 'new' && (
              <input
                aria-label="New findings note title"
                value={title}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
                className="border-border bg-default text-default rounded border px-2 py-1"
              />
            )}
          </div>
          <p className="text-passive-1 my-1">
            {target === 'new'
              ? 'Create a new note preserving the complete findings and citations as Markdown?'
              : 'Append these findings and citations to the selected note? Existing content will be kept.'}
          </p>
          <div className="flex gap-2">
            <Button
              small
              disabled={busy || appendTooLarge}
              onClick={() => {
                void save()
              }}
            >
              {busy ? 'Saving…' : target === 'new' ? 'Create note' : 'Append findings'}
            </Button>
            <Button small disabled={busy} onClick={() => setExpanded(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {appendTooLarge && (
        <p className="text-passive-1 mt-1">
          This report is too long to append to an existing rich note in one safe edit. Choose New note to save the
          complete findings.
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger mt-1">
          {error}
        </p>
      )}
    </div>
  )
}
