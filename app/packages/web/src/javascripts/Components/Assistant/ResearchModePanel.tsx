import { useCallback, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { getResearchModeAvailability, runResearchModeForApplication } from '@/Assistant/researchModeRunner'
import { ResearchModeResult } from '@/Assistant/researchMode'

type Props = {
  application: WebApplication
  /** Close the panel and return to the chat. */
  onClose: () => void
}

function ResearchModePanelImpl({ application, onClose }: Props) {
  const { presentPane } = useResponsiveAppPane()

  const [topic, setTopic] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<ResearchModeResult | null>(null)
  const [createdNoteUuid, setCreatedNoteUuid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const availability = useMemo(() => getResearchModeAvailability(application), [application])

  const run = useCallback(async () => {
    const trimmed = topic.trim()
    if (!trimmed || isRunning) {
      return
    }
    setError(null)
    setResult(null)
    setCreatedNoteUuid(null)
    setIsRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const run = await runResearchModeForApplication(application, trimmed, { signal: controller.signal })
      if (run === null) {
        if (!controller.signal.aborted) {
          setError(getResearchModeAvailability(application).reason || 'Research mode is unavailable.')
        }
      } else {
        setResult(run.result)
        setCreatedNoteUuid(run.noteUuid)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }, [application, topic, isRunning])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const openNote = useCallback(
    (uuid: string) => {
      void application.itemListController.openNote(uuid)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon type="notes" className="text-info" />
          Research mode
        </div>
        <button
          className="rounded p-1 hover:bg-contrast"
          onClick={onClose}
          aria-label="Back to chat"
          title="Back to chat"
        >
          <Icon type="close" size="small" />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto px-4 py-3">
        <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm text-warning">
          Research mode writes a structured note on your topic using the AI model&rsquo;s own knowledge.{' '}
          <strong>There is no live web access here</strong>, so the result can be outdated or wrong and any sources are
          the model&rsquo;s recollections — they must be independently verified. The note it creates includes this
          warning at the bottom.
        </div>

        {!availability.available && (
          <div className="mt-3 rounded border border-border bg-contrast p-3 text-sm text-neutral">
            {availability.reason || 'Research mode is unavailable.'}
          </div>
        )}

        <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-passive-1">
          Topic or question
        </label>
        <textarea
          className="mt-1 w-full resize-none rounded border border-border bg-default px-3 py-2 text-sm focus:border-info focus:outline-none"
          rows={3}
          placeholder="e.g. An overview of the CRISPR-Cas9 mechanism"
          value={topic}
          disabled={isRunning || !availability.available}
          onChange={(event) => setTopic(event.target.value)}
        />

        <div className="mt-2 flex items-center gap-2">
          {isRunning ? (
            <Button label="Stop" onClick={stop} />
          ) : (
            <Button
              primary
              label="Research & create note"
              onClick={() => void run()}
              disabled={!topic.trim() || !availability.available}
            />
          )}
          {isRunning && <span className="text-xs text-passive-0">Researching…</span>}
        </div>

        {error && (
          <div className="mt-3 rounded border border-danger bg-default px-3 py-2 text-sm text-danger">{error}</div>
        )}

        {result && (
          <div className="mt-4">
            <div className="mb-2 text-sm text-text">
              Created a note: <span className="font-semibold">{result.title}</span>
            </div>
            {createdNoteUuid && (
              <Button label="Open note" onClick={() => openNote(createdNoteUuid)} />
            )}
            <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-contrast px-3 py-2 text-sm text-text">
              {result.body}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const ResearchModePanel = observer(ResearchModePanelImpl)

export default ResearchModePanel
