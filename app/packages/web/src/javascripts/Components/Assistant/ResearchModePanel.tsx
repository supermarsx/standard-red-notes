import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { getResearchModeAvailability, runResearchModeForApplication } from '@/Assistant/researchModeRunner'
import { ResearchModeResult } from '@/Assistant/researchMode'
import {
  AssistantSessionPrincipal,
  assistantSessionPrincipalMatches,
  captureAssistantSessionPrincipal,
} from '@/Assistant/assistantSessionPrincipal'

type Props = {
  application: WebApplication
  /** Close the panel and return to the chat. */
  onClose: () => void
  onTopicChange?: (topic: string) => void
}

function ResearchModePanelImpl({ application, onClose, onTopicChange }: Props) {
  const { presentPane } = useResponsiveAppPane()

  const [topic, setTopic] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<ResearchModeResult | null>(null)
  const [createdNoteUuid, setCreatedNoteUuid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runPrincipalRef = useRef<AssistantSessionPrincipal | null>(null)
  const mountedRef = useRef(true)
  const [, setPreferenceRevision] = useState(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      runPrincipalRef.current = null
    }
  }, [])

  useEffect(() => {
    return application.addEventObserver(async (event) => {
      if (!mountedRef.current) {
        return
      }
      if (
        event === ApplicationEvent.PreferencesChanged ||
        event === ApplicationEvent.SignedIn ||
        event === ApplicationEvent.SignedOut ||
        event === ApplicationEvent.KeyStatusChanged
      ) {
        if (
          event === ApplicationEvent.SignedIn ||
          event === ApplicationEvent.SignedOut ||
          event === ApplicationEvent.KeyStatusChanged
        ) {
          const runPrincipal = runPrincipalRef.current
          if (
            event === ApplicationEvent.KeyStatusChanged ||
            (runPrincipal &&
              !assistantSessionPrincipalMatches(runPrincipal, captureAssistantSessionPrincipal(application.sessions)))
          ) {
            abortRef.current?.abort()
          }
        }
        setPreferenceRevision((revision) => revision + 1)
      }
    })
  }, [application])

  const availability = getResearchModeAvailability(application)

  const run = useCallback(async () => {
    const trimmed = topic.trim()
    if (!trimmed || isRunning || abortRef.current) {
      return
    }
    onTopicChange?.(trimmed)
    setError(null)
    setResult(null)
    setCreatedNoteUuid(null)
    setIsRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    runPrincipalRef.current = captureAssistantSessionPrincipal(application.sessions)
    try {
      const run = await runResearchModeForApplication(application, trimmed, {
        signal: controller.signal,
        webAccess: true,
      })
      if (!mountedRef.current || controller.signal.aborted) {
        return
      }
      if (run === null) {
        setError(getResearchModeAvailability(application).reason || 'Research mode is unavailable.')
      } else {
        setResult(run.result)
        setCreatedNoteUuid(run.noteUuid)
      }
    } catch (caught) {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (mountedRef.current) {
        setIsRunning(false)
        if (abortRef.current === controller) {
          abortRef.current = null
          runPrincipalRef.current = null
        }
      }
    }
  }, [application, topic, isRunning, onTopicChange])

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
      <div className="border-border bg-contrast flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon type="notes" className="text-info" />
          Research mode
        </div>
        <button
          className="hover:bg-contrast rounded p-1"
          onClick={onClose}
          aria-label="Back to chat"
          title="Back to chat"
        >
          <Icon type="close" size="small" />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto px-4 py-3">
        <div className="border-warning bg-warning-faded text-warning rounded border border-solid p-3 text-sm">
          Research mode searches through your server&rsquo;s configured web service, then reads up to three pages. Web
          requests follow your Allow, Safe or Strict setting and leave end-to-end encryption. Retrieved text is sent to
          your AI provider; your notes are not used as search queries. The report links the pages actually retrieved and
          states when web access was unavailable or declined. Verify important claims against those sources.
        </div>

        {!availability.available && (
          <div className="border-border bg-contrast text-neutral mt-3 rounded border p-3 text-sm">
            {availability.reason || 'Research mode is unavailable.'}
          </div>
        )}

        <label className="text-passive-1 mt-3 block text-xs font-semibold tracking-wide uppercase">
          Topic or question
        </label>
        <textarea
          className="border-border bg-default focus:border-info mt-1 w-full resize-none rounded border px-3 py-2 text-sm focus:outline-none"
          rows={3}
          placeholder="e.g. An overview of the CRISPR-Cas9 mechanism"
          value={topic}
          disabled={isRunning || !availability.available}
          onChange={(event) => {
            setTopic(event.target.value)
            onTopicChange?.(event.target.value)
          }}
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
          {isRunning && <span className="text-passive-0 text-xs">Researching…</span>}
        </div>

        {error && (
          <div className="border-danger bg-default text-danger mt-3 rounded border px-3 py-2 text-sm">{error}</div>
        )}

        {result && (
          <div className="mt-4">
            <div className="text-text mb-2 text-sm">
              Created a note: <span className="font-semibold">{result.title}</span>
            </div>
            {createdNoteUuid && <Button label="Open note" onClick={() => openNote(createdNoteUuid)} />}
            <div className="bg-contrast text-text mt-3 max-h-72 overflow-y-auto rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
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
