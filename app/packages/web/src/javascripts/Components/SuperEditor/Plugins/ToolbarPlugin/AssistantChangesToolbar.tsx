import {
  acceptAssistantChange,
  AssistantChangeRecord,
  dismissAssistantChange,
  undoAssistantChange,
} from '@/Assistant/assistantChangeLedger'
import { useAssistantChangeLedger } from '@/Assistant/useAssistantChangeLedger'
import { useApplication } from '@/Components/ApplicationProvider'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { classNames } from '@standardnotes/snjs'
import { ToolbarItem } from '@ariakit/react'
import { LexicalEditor } from 'lexical'
import { useCallback, useRef, useState } from 'react'
import { jumpToAssistantChange } from '../AssistantChangeDecorationsPlugin'

type ActionName = 'accept' | 'dismiss' | 'undo'

type ActionError = {
  changeId: string
  message: string
  reviewSuggested: boolean
}

const actionClassName =
  'border-border hover:bg-contrast focus-visible:border-info rounded border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40'

function Diff({ record }: { record: AssistantChangeRecord }) {
  if (!record.undo.patch) {
    return <p className="text-passive-1 mt-2 text-xs">No textual diff was produced for this structural change.</p>
  }

  return (
    <details className="mt-2">
      <summary className="text-passive-0 cursor-pointer text-xs font-medium select-none">
        Diff · <span className="text-success">+{record.undo.addedLines}</span>{' '}
        <span className="text-danger">−{record.undo.removedLines}</span>
      </summary>
      <pre
        className="border-border bg-default mt-1 max-h-64 overflow-auto rounded border p-2 font-mono text-[11px] leading-4"
        aria-label={`AI changes made to ${record.undo.noteTitle}`}
      >
        {record.undo.patch.split('\n').map((line, index) => (
          <span
            key={`${index}-${line.slice(0, 24)}`}
            className={classNames(
              'block min-w-max whitespace-pre',
              line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
              line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
              line.startsWith('@@') && 'text-info',
              (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++')) &&
                'text-passive-0 font-semibold',
            )}
          >
            {line || ' '}
          </span>
        ))}
      </pre>
    </details>
  )
}

function OperationFragments({ record }: { record: AssistantChangeRecord }) {
  return (
    <details className="mt-2">
      <summary className="text-passive-0 cursor-pointer text-xs font-medium select-none">Before and after</summary>
      <div className="mt-1 space-y-2">
        {record.operations.map((operation) => (
          <section className="border-border rounded border p-2" key={operation.operationId}>
            <div className="text-xs font-semibold">{operation.summary}</div>
            <div className="mt-1 grid grid-cols-1 gap-1.5 md:grid-cols-2">
              <div>
                <div className="text-passive-1 text-[10px] font-semibold tracking-wide uppercase">Before</div>
                <pre className="bg-default mt-0.5 max-h-28 overflow-auto rounded p-1.5 text-[10px] whitespace-pre-wrap">
                  {operation.beforeFragment ?? '(not present)'}
                </pre>
              </div>
              <div>
                <div className="text-passive-1 text-[10px] font-semibold tracking-wide uppercase">After</div>
                <pre className="bg-default mt-0.5 max-h-28 overflow-auto rounded p-1.5 text-[10px] whitespace-pre-wrap">
                  {operation.deleted ? '(deleted — see diff)' : (operation.afterFragment ?? '(not present)')}
                </pre>
              </div>
            </div>
            {operation.truncated && (
              <div className="text-passive-1 mt-1 text-[10px]">Fragment was safely truncated.</div>
            )}
          </section>
        ))}
      </div>
    </details>
  )
}

export function AssistantChangesToolbar({ noteUuid, editor }: { noteUuid?: string; editor: LexicalEditor }) {
  const application = useApplication()
  const { authorized, note, records } = useAssistantChangeLedger(noteUuid)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<{ changeId: string; action: ActionName }>()
  const [actionError, setActionError] = useState<ActionError>()
  const anchorRef = useRef<HTMLButtonElement>(null)

  const runAction = useCallback(
    async (record: AssistantChangeRecord, action: ActionName): Promise<void> => {
      if (!noteUuid || pending) {
        return
      }
      setPending({ changeId: record.changeId, action })
      setActionError(undefined)
      try {
        if (action === 'accept') {
          await acceptAssistantChange(application, noteUuid, record.changeId)
        } else if (action === 'dismiss') {
          await dismissAssistantChange(application, noteUuid, record.changeId)
        } else {
          await undoAssistantChange(application, noteUuid, record.changeId)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The assistant change action could not be completed.'
        setActionError({
          changeId: record.changeId,
          message,
          reviewSuggested: action === 'undo',
        })
      } finally {
        setPending(undefined)
      }
    },
    [application, noteUuid, pending],
  )

  const jump = useCallback(
    (record: AssistantChangeRecord): void => {
      setActionError(undefined)
      if (!jumpToAssistantChange(editor, record, note)) {
        setActionError({
          changeId: record.changeId,
          message: record.operations.every((operation) => operation.deleted)
            ? 'This change only deleted content. Review its before state in the diff.'
            : 'The affected block moved or no longer exists. Review the current note and diff.',
          reviewSuggested: false,
        })
      }
    },
    [editor, note],
  )

  if (!noteUuid || !authorized) {
    return null
  }

  return (
    <>
      <ToolbarItem
        ref={anchorRef}
        type="button"
        className="hover:bg-passive-4 focus-visible:bg-passive-4 flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none"
        aria-label={`AI changes, ${records.length} ${records.length === 1 ? 'change' : 'changes'}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon type="sparkle" size="custom" className="super-toolbar-icon" />
        <span className="whitespace-nowrap">AI changes ({records.length})</span>
      </ToolbarItem>
      <Popover
        title="AI changes"
        anchorElement={anchorRef}
        open={open}
        togglePopover={() => setOpen((value) => !value)}
        side="bottom"
        align="end"
        className="max-h-[70vh] overflow-y-auto p-3"
        containerClassName="md:!w-[40rem] md:!max-w-2xl"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">AI changes</h2>
            <p className="text-passive-1 text-xs">Encrypted history stored with this note.</p>
          </div>
          <span className="bg-contrast rounded-full px-2 py-0.5 text-xs font-semibold">{records.length}</span>
        </div>

        {records.length === 0 ? (
          <p className="text-passive-1 border-border rounded border border-dashed p-3 text-sm">
            No retained AI changes for this note.
          </p>
        ) : (
          <ol className="space-y-2">
            {records.map((record) => {
              const isPending = pending?.changeId === record.changeId
              const error = actionError?.changeId === record.changeId ? actionError : undefined
              return (
                <li className="border-border bg-contrast rounded border p-2.5" key={record.changeId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        {record.operations.length} {record.operations.length === 1 ? 'operation' : 'operations'}
                      </div>
                      <div className="text-passive-1 text-[11px]">
                        {new Date(record.createdAt).toLocaleString()} · {record.status}
                      </div>
                    </div>
                    <button type="button" className={actionClassName} onClick={() => jump(record)}>
                      Jump to change
                    </button>
                  </div>

                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">
                    {record.operations.map((operation) => (
                      <li key={operation.operationId}>{operation.summary}</li>
                    ))}
                  </ul>

                  <OperationFragments record={record} />
                  <Diff record={record} />

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {record.status === 'applied' && (
                      <>
                        <button
                          type="button"
                          className={actionClassName}
                          disabled={Boolean(pending)}
                          onClick={() => void runAction(record, 'accept')}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className={actionClassName}
                          disabled={Boolean(pending)}
                          onClick={() => void runAction(record, 'dismiss')}
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                    {record.status !== 'undone' && (
                      <button
                        type="button"
                        className={actionClassName}
                        disabled={Boolean(pending)}
                        onClick={() => void runAction(record, 'undo')}
                      >
                        Undo
                      </button>
                    )}
                    {isPending && (
                      <span className="text-passive-1 text-xs" role="status">
                        {pending.action === 'undo' ? 'Checking and undoing…' : 'Saving…'}
                      </span>
                    )}
                  </div>

                  {error && (
                    <div className="text-danger mt-2 text-xs" role="alert">
                      <p>{error.message}</p>
                      {error.reviewSuggested && (
                        <button
                          type="button"
                          className="border-danger mt-1 rounded border px-2 py-1 font-medium"
                          onClick={() => jump(record)}
                        >
                          Review current note
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </Popover>
    </>
  )
}

export default AssistantChangesToolbar
