import { FunctionComponent, ReactNode, useCallback, useMemo, useState } from 'react'
import { FileItem } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'
import type { WebApplication } from '@/Application/WebApplication'
import { ToastType, addToast } from '@standardnotes/toast'
import { BulkFileFailure, BulkFileProgress, describeBulkFileError } from './bulkFileOperation'

type Props = {
  application: WebApplication
  selectedFiles: FileItem[]
  totalFileCount: number
  onSelectAll: () => void
  onClearSelection: () => void
  /**
   * Receives the files that genuinely completed, so the caller can drop them from
   * the selection and leave only the failures behind for a retry.
   */
  onFilesProcessed: (files: FileItem[]) => void
  /** Slot for selection-wide options that are not batched here (tags, vaults, archive). */
  moreActions?: ReactNode
}

type ActionSummary = {
  verb: string
  succeededCount: number
  failures: BulkFileFailure[]
}

const buttonClass = 'border-border hover:bg-contrast rounded border px-2 py-1 text-sm disabled:opacity-50'

const pluralFiles = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`

const reportOutcome = (verb: string, succeededCount: number, failures: BulkFileFailure[]) => {
  if (failures.length === 0) {
    addToast({ type: ToastType.Success, message: `${verb} ${pluralFiles(succeededCount)}.` })
    return
  }
  addToast({
    type: ToastType.Error,
    message: `${verb} ${succeededCount} of ${pluralFiles(succeededCount + failures.length)}. ${
      failures.length
    } failed: ${failures.map((failure) => failure.name).join(', ')}`,
  })
}

/**
 * Standard Red Notes: the bulk management bar for the Files table.
 *
 * Every action here reports a per-file verdict. Nothing is ever announced as a
 * clean success while some of the selection silently failed — the failures are
 * listed by name with their reason and stay selected so a retry hits only them.
 */
const BulkFileActionBar: FunctionComponent<Props> = ({
  application,
  selectedFiles,
  totalFileCount,
  onSelectAll,
  onClearSelection,
  onFilesProcessed,
  moreActions,
}) => {
  const [runningAction, setRunningAction] = useState<string>()
  const [progress, setProgress] = useState<BulkFileProgress>()
  const [summary, setSummary] = useState<ActionSummary>()

  const selectedCount = selectedFiles.length
  const allSelected = totalFileCount > 0 && selectedCount === totalFileCount
  const isRunning = runningAction !== undefined

  const anyProtected = useMemo(() => selectedFiles.some((file) => file.protected), [selectedFiles])
  const anyUnprotected = useMemo(() => selectedFiles.some((file) => !file.protected), [selectedFiles])

  const runAction = useCallback(
    async (
      verb: string,
      run: (onProgress: (progress: BulkFileProgress) => void) => Promise<{
        succeeded: FileItem[]
        failed: BulkFileFailure[]
      } | void>,
    ) => {
      setRunningAction(verb)
      setSummary(undefined)
      setProgress({ completed: 0, total: selectedCount })

      try {
        const result = await run(setProgress)
        if (!result) {
          // The action was declined or cancelled; leave the selection untouched.
          return
        }
        setSummary({ verb, succeededCount: result.succeeded.length, failures: result.failed })
        reportOutcome(verb, result.succeeded.length, result.failed)
        if (result.succeeded.length > 0) {
          // The bar unmounts once the selection empties, so the outcome is also
          // announced outside it — a completed batch must never pass silently.
          onFilesProcessed(result.succeeded)
        }
      } catch (error) {
        const failures = selectedFiles.map((file) => ({
          uuid: file.uuid,
          name: file.name,
          message: describeBulkFileError(error),
        }))
        setSummary({ verb, succeededCount: 0, failures })
        reportOutcome(verb, 0, failures)
      } finally {
        setRunningAction(undefined)
        setProgress(undefined)
      }
    },
    [onFilesProcessed, selectedCount, selectedFiles],
  )

  const onDownload = useCallback(() => {
    void runAction('Downloaded', (onProgress) =>
      application.filesController.downloadFiles(selectedFiles, { onProgress }),
    )
  }, [application, runAction, selectedFiles])

  const onDelete = useCallback(() => {
    void runAction('Deleted', (onProgress) =>
      application.filesController.deleteFilesPermanently(selectedFiles, { onProgress }),
    )
  }, [application, runAction, selectedFiles])

  const onSetProtection = useCallback(
    (protect: boolean) => {
      const targets = selectedFiles.filter((file) => file.protected !== protect)
      void runAction(protect ? 'Protected' : 'Unprotected', async () => {
        await application.filesController.setProtectionForFiles(protect, targets)
        // Protection is applied as one atomic local mutation, so reaching here
        // means every targeted file changed.
        return { succeeded: targets, failed: [] }
      })
    },
    [application, runAction, selectedFiles],
  )

  const selectionLabel = `${pluralFiles(selectedCount)} selected`

  return (
    <section
      aria-label={`Bulk file actions — ${selectionLabel}`}
      className="border-border border-b px-4 py-2"
      data-testid="bulk-file-action-bar"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold" data-testid="bulk-selection-count">
          {selectionLabel}
        </span>
        <button className={buttonClass} onClick={onSelectAll} disabled={isRunning || allSelected}>
          Select all {totalFileCount}
        </button>
        <button className={buttonClass} onClick={onClearSelection} disabled={isRunning}>
          Clear
        </button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className={buttonClass} onClick={onDownload} disabled={isRunning}>
            <span className="flex items-center gap-1">
              <Icon type="download" size="medium" />
              Download
            </span>
          </button>
          {anyUnprotected && (
            <button className={buttonClass} onClick={() => onSetProtection(true)} disabled={isRunning}>
              <span className="flex items-center gap-1">
                <Icon type="lock" size="medium" />
                Protect
              </span>
            </button>
          )}
          {anyProtected && (
            <button className={buttonClass} onClick={() => onSetProtection(false)} disabled={isRunning}>
              <span className="flex items-center gap-1">
                <Icon type="unlock" size="medium" />
                Unprotect
              </span>
            </button>
          )}
          <button
            className={classNames(buttonClass, 'text-danger border-danger')}
            onClick={onDelete}
            disabled={isRunning}
          >
            <span className="flex items-center gap-1">
              <Icon type="trash" size="medium" />
              Delete
            </span>
          </button>
          {moreActions}
        </div>
      </div>

      {progress && (
        <div role="status" aria-live="polite" className="text-passive-1 mt-2 text-xs" data-testid="bulk-progress">
          {runningAction === 'Deleted' ? 'Deleting' : runningAction === 'Downloaded' ? 'Downloading' : 'Updating'}{' '}
          {progress.completed} of {progress.total}…
        </div>
      )}

      {summary && (
        <div role="alert" className="mt-2 text-xs" data-testid="bulk-summary">
          {summary.failures.length === 0 ? (
            <span className="text-passive-1">
              {summary.verb} {pluralFiles(summary.succeededCount)}.
            </span>
          ) : (
            <div className="text-danger">
              <div className="font-semibold" data-testid="bulk-failure-headline">
                {summary.verb} {summary.succeededCount} of {summary.succeededCount + summary.failures.length} files.{' '}
                {summary.failures.length} failed and {summary.failures.length === 1 ? 'remains' : 'remain'} selected:
              </div>
              <ul className="mt-1 list-disc pl-5">
                {summary.failures.map((failure) => (
                  <li key={failure.uuid} data-testid="bulk-failure-item">
                    <span className="font-medium">{failure.name}</span> — {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default BulkFileActionBar
