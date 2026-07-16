import { useCallback, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { DeepResearchProgress, DeepResearchReport, DEFAULT_DEEP_RESEARCH_LIMITS } from '@/Assistant/deepResearch'
import { getDeepResearchAvailability, runDeepResearchForApplication } from '@/Assistant/deepResearchRunner'

type Props = {
  application: WebApplication
  /** Close the panel and return to the chat. */
  onClose: () => void
}

const progressLabel = (progress: DeepResearchProgress): string => {
  switch (progress.kind) {
    case 'searching':
      return 'Searching your notes…'
    case 'reading':
      return `Reading ${progress.noteCount} note${progress.noteCount === 1 ? '' : 's'}…`
    case 'refining':
      return `Refining (round ${progress.round})…`
    case 'synthesizing':
      return 'Synthesizing the report…'
  }
}

function DeepResearchPanelImpl({ application, onClose }: Props) {
  const { presentPane } = useResponsiveAppPane()

  const [question, setQuestion] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState<DeepResearchProgress | null>(null)
  const [report, setReport] = useState<DeepResearchReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const availability = useMemo(() => getDeepResearchAvailability(application), [application])

  const run = useCallback(async () => {
    const trimmed = question.trim()
    if (!trimmed || isRunning) {
      return
    }
    setError(null)
    setReport(null)
    setIsRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await runDeepResearchForApplication(application, trimmed, {
        signal: controller.signal,
        onProgress: (phase) => setProgress(phase),
      })
      if (result === null) {
        setError(getDeepResearchAvailability(application).reason || 'Deep research is unavailable.')
      } else {
        setReport(result)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsRunning(false)
      setProgress(null)
      abortRef.current = null
    }
  }, [application, question, isRunning])

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
          <Icon type="search" className="text-info" />
          Deep research
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
          Deep research reads several of your notes and sends those excerpts to your AI provider across multiple steps —
          more exposure than a single question. It is a bounded loop (≤ {DEFAULT_DEEP_RESEARCH_LIMITS.maxRounds} rounds,
          ≤ {DEFAULT_DEEP_RESEARCH_LIMITS.maxNotes} notes, truncated snippets) over your OWN notes only — there is no
          web search here.
        </div>

        {!availability.available && (
          <div className="border-border bg-contrast text-neutral mt-3 rounded border p-3 text-sm">
            {availability.reason || 'Deep research is unavailable.'}
          </div>
        )}

        <label className="text-passive-1 mt-3 block text-xs font-semibold tracking-wide uppercase">
          Research question
        </label>
        <textarea
          className="border-border bg-default focus:border-info mt-1 w-full resize-none rounded border px-3 py-2 text-sm focus:outline-none"
          rows={3}
          placeholder="e.g. What have I noted about our pricing strategy?"
          value={question}
          disabled={isRunning || !availability.available}
          onChange={(event) => setQuestion(event.target.value)}
        />

        <div className="mt-2 flex items-center gap-2">
          {isRunning ? (
            <Button label="Stop" onClick={stop} />
          ) : (
            <Button
              primary
              label="Run deep research"
              onClick={() => void run()}
              disabled={!question.trim() || !availability.available}
            />
          )}
          {progress && <span className="text-passive-0 text-xs">{progressLabel(progress)}</span>}
        </div>

        {error && (
          <div className="border-danger bg-default text-danger mt-3 rounded border px-3 py-2 text-sm">{error}</div>
        )}

        {report && (
          <div className="mt-4">
            {report.report && (
              <div className="bg-contrast text-text rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
                {report.report}
              </div>
            )}

            {report.sources.length > 0 && (
              <div className="mt-3">
                <div className="text-passive-1 mb-1 text-xs font-semibold tracking-wide uppercase">
                  Cited sources ({report.sources.length})
                </div>
                <ol className="flex flex-col gap-1">
                  {report.sources.map((source, index) => (
                    <li key={source.uuid} className="flex items-start gap-2 text-sm">
                      <span className="text-passive-1 mt-0.5 flex-shrink-0">[{index + 1}]</span>
                      <button
                        className="text-info text-left hover:underline"
                        onClick={() => openNote(source.uuid)}
                        title="Open this note"
                      >
                        {source.title}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div
              className={classNames(
                'text-passive-1 mt-3 text-xs',
                report.stopReason === 'no-candidates' && 'text-warning',
              )}
            >
              {report.rounds > 0 && `Ran ${report.rounds} round${report.rounds === 1 ? '' : 's'}; `}
              read {report.sources.length} note{report.sources.length === 1 ? '' : 's'} (
              {stopReasonLabel(report.stopReason)}).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const stopReasonLabel = (reason: DeepResearchReport['stopReason']): string => {
  switch (reason) {
    case 'model-finished':
      return 'model had enough'
    case 'max-rounds':
      return 'reached the round cap'
    case 'no-new-notes':
      return 'no more relevant notes'
    case 'no-candidates':
      return 'no matching notes'
    case 'aborted':
      return 'stopped'
  }
}

const DeepResearchPanel = observer(DeepResearchPanelImpl)

export default DeepResearchPanel
