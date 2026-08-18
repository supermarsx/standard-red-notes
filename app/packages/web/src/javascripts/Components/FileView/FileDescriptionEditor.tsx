import { WebApplication } from '@/Application/WebApplication'
import { type FileItem, MAX_FILE_DESCRIPTION_LENGTH, normalizeFileDescription } from '@standardnotes/models'
import { KeyboardEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  application: WebApplication
  file: FileItem
  readonly: boolean
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

type SaveRequest = {
  file: FileItem
  description: string | undefined
  showStatus: boolean
}

export const FileDescriptionSaveDebounceMs = 700

const FileDescriptionEditor = ({ application, file, readonly }: Props) => {
  const { t } = useTranslation('files')
  const [draft, setDraft] = useState(file.description ?? '')
  const [status, setStatus] = useState<SaveStatus>('idle')

  const mountedRef = useRef(false)
  const applicationRef = useRef(application)
  const activeFileRef = useRef(file)
  const activeFileUuidRef = useRef(file.uuid)
  const draftRef = useRef(file.description ?? '')
  const writableByFileRef = useRef(new Map<string, boolean>([[file.uuid, !readonly]]))
  const acknowledgedDescriptionsRef = useRef(new Map<string, string | undefined>([[file.uuid, file.description]]))
  const pendingSavesRef = useRef(new Map<string, SaveRequest>())
  const activeSaveRef = useRef<SaveRequest | undefined>(undefined)
  const saveWorkerRef = useRef<Promise<void> | undefined>(undefined)
  const debounceTimeoutRef = useRef<number | undefined>(undefined)

  applicationRef.current = application
  writableByFileRef.current.set(file.uuid, !readonly)

  const setDraftValue = useCallback((value: string) => {
    draftRef.current = value
    if (mountedRef.current) {
      setDraft(value)
    }
  }, [])

  const setStatusForRequest = useCallback((request: SaveRequest, nextStatus: SaveStatus) => {
    if (mountedRef.current && request.showStatus && activeFileUuidRef.current === request.file.uuid) {
      setStatus(nextStatus)
    }
  }, [])

  const startSaveWorker = useCallback((): Promise<void> => {
    if (saveWorkerRef.current) {
      return saveWorkerRef.current
    }

    const worker = (async () => {
      while (pendingSavesRef.current.size > 0) {
        const entry = pendingSavesRef.current.entries().next().value as [string, SaveRequest] | undefined
        if (!entry) {
          break
        }

        const [fileUuid, request] = entry
        pendingSavesRef.current.delete(fileUuid)
        activeSaveRef.current = request

        const acknowledgedDescription = acknowledgedDescriptionsRef.current.get(fileUuid)
        if (request.description === acknowledgedDescription) {
          activeSaveRef.current = undefined
          continue
        }

        if (!writableByFileRef.current.get(fileUuid)) {
          activeSaveRef.current = undefined
          continue
        }

        setStatusForRequest(request, 'saving')

        let didAcknowledgeLocalPersistence = false
        try {
          const updatedFile = await applicationRef.current.mutator.setFileDescription(request.file, request.description)

          // Permission can be revoked while the local mutation is awaiting. Do not
          // intentionally upload that mutation after the UI learns it is readonly.
          if (!writableByFileRef.current.get(fileUuid)) {
            activeSaveRef.current = undefined
            continue
          }

          await applicationRef.current.sync.sync({
            onPresyncSave: () => {
              didAcknowledgeLocalPersistence = true
              acknowledgedDescriptionsRef.current.set(fileUuid, request.description)

              if (activeFileUuidRef.current === fileUuid) {
                activeFileRef.current = updatedFile
              }

              const hasNewerRequest = pendingSavesRef.current.has(fileUuid)
              const currentDraftMatches = normalizeFileDescription(draftRef.current) === request.description
              if (!hasNewerRequest && currentDraftMatches) {
                setDraftValue(request.description ?? '')
                setStatusForRequest(request, 'saved')
              }
            },
          })

          if (!didAcknowledgeLocalPersistence) {
            throw new Error('File description sync completed without acknowledging local persistence.')
          }
        } catch {
          // Keep the acknowledgement at its previous durable value. Even if the
          // in-memory FileItem already reflects this description, the next blur or
          // debounce must retry both the mutation and persistence acknowledgement.
          if (!didAcknowledgeLocalPersistence) {
            setStatusForRequest(request, 'error')
          }
        } finally {
          activeSaveRef.current = undefined
        }
      }
    })()

    saveWorkerRef.current = worker
    void worker.finally(() => {
      if (saveWorkerRef.current === worker) {
        saveWorkerRef.current = undefined
      }
      if (pendingSavesRef.current.size > 0) {
        void startSaveWorker()
      }
    })
    return worker
  }, [setDraftValue, setStatusForRequest])

  const queueSave = useCallback(
    (targetFile: FileItem, rawDescription: string, showStatus: boolean): Promise<void> => {
      const fileUuid = targetFile.uuid
      if (!writableByFileRef.current.get(fileUuid)) {
        return Promise.resolve()
      }

      const description = normalizeFileDescription(rawDescription)
      const activeSaveForFile = activeSaveRef.current?.file.uuid === fileUuid
      const alreadyPendingForFile = pendingSavesRef.current.has(fileUuid)
      const acknowledgedDescription = acknowledgedDescriptionsRef.current.get(fileUuid)

      if (description === acknowledgedDescription && !activeSaveForFile && !alreadyPendingForFile) {
        if (showStatus && activeFileUuidRef.current === fileUuid) {
          setDraftValue(description ?? '')
          if (mountedRef.current) {
            setStatus('idle')
          }
        }
        return saveWorkerRef.current ?? Promise.resolve()
      }

      pendingSavesRef.current.set(fileUuid, { file: targetFile, description, showStatus })
      return startSaveWorker()
    },
    [setDraftValue, startSaveWorker],
  )

  const clearDebounce = useCallback(() => {
    if (debounceTimeoutRef.current !== undefined) {
      window.clearTimeout(debounceTimeoutRef.current)
      debounceTimeoutRef.current = undefined
    }
  }, [])

  const flushCurrentDraft = useCallback(
    (showStatus = true): Promise<void> => {
      clearDebounce()
      return queueSave(activeFileRef.current, draftRef.current, showStatus)
    },
    [clearDebounce, queueSave],
  )

  const scheduleAutosave = useCallback(() => {
    clearDebounce()
    debounceTimeoutRef.current = window.setTimeout(() => {
      debounceTimeoutRef.current = undefined
      void queueSave(activeFileRef.current, draftRef.current, true)
    }, FileDescriptionSaveDebounceMs)
  }, [clearDebounce, queueSave])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      clearDebounce()
      mountedRef.current = false
      void queueSave(activeFileRef.current, draftRef.current, false)
    }
  }, [clearDebounce, queueSave])

  useEffect(() => {
    const previousFile = activeFileRef.current
    if (previousFile.uuid !== file.uuid) {
      clearDebounce()
      void queueSave(previousFile, draftRef.current, false)

      activeFileRef.current = file
      activeFileUuidRef.current = file.uuid
      acknowledgedDescriptionsRef.current.set(file.uuid, file.description)
      draftRef.current = file.description ?? ''
      setDraft(file.description ?? '')
      setStatus('idle')
      return
    }

    activeFileRef.current = file

    if (readonly) {
      clearDebounce()
      pendingSavesRef.current.delete(file.uuid)
      setStatus('idle')
      return
    }

    const acknowledgedDescription = acknowledgedDescriptionsRef.current.get(file.uuid)
    const draftIsDirty = normalizeFileDescription(draftRef.current) !== acknowledgedDescription
    const saveIsActive = activeSaveRef.current?.file.uuid === file.uuid || pendingSavesRef.current.has(file.uuid)

    // Adopt a same-file external update only when there is no local draft or save
    // to protect. In-memory echoes from our own pre-persistence mutation therefore
    // cannot erase an error or trick equality checks into skipping a retry.
    if (!draftIsDirty && !saveIsActive) {
      acknowledgedDescriptionsRef.current.set(file.uuid, file.description)
      if (draftRef.current !== (file.description ?? '')) {
        setDraftValue(file.description ?? '')
      }
      setStatus('idle')
    }
  }, [clearDebounce, file, queueSave, readonly, setDraftValue])

  const onKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void flushCurrentDraft()
      event.currentTarget.blur()
    }
  }

  const statusText =
    status === 'saving'
      ? t('fileDescriptionSaving')
      : status === 'saved'
        ? t('fileDescriptionSaved')
        : status === 'error'
          ? t('fileDescriptionSaveFailed')
          : ''

  return (
    <div className="border-border mt-2 border-t px-1 pt-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-sm font-medium" htmlFor={`file-description-${file.uuid}`}>
          {t('fileDescription')}
        </label>
        <span className="text-passive-1 text-xs" aria-live="polite">
          {statusText || t('fileDescriptionCharacterCount', { count: draft.length, max: MAX_FILE_DESCRIPTION_LENGTH })}
        </span>
      </div>
      <textarea
        id={`file-description-${file.uuid}`}
        className="border-border bg-default text-text placeholder:text-passive-1 min-h-16 w-full resize-y rounded border px-2 py-1.5 text-sm"
        value={draft}
        maxLength={MAX_FILE_DESCRIPTION_LENGTH}
        rows={2}
        disabled={readonly}
        aria-invalid={status === 'error'}
        placeholder={readonly ? t('fileDescriptionEmpty') : t('fileDescriptionPlaceholder')}
        onChange={(event) => {
          if (readonly) {
            return
          }
          draftRef.current = event.target.value
          setDraft(event.target.value)
          setStatus('idle')
          scheduleAutosave()
        }}
        onBlur={() => void flushCurrentDraft()}
        onKeyDown={onKeyDown}
      />
      {!readonly && <p className="text-passive-1 mt-1 text-xs">{t('fileDescriptionHint')}</p>}
    </div>
  )
}

export default FileDescriptionEditor
