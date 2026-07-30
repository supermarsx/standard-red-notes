import { useCallback, useEffect, useRef } from 'react'

export const CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS = 400

export type EditorPersistenceFlushController = {
  registerEditorFlush(flush: () => void, hasPending: () => boolean): () => void
}

type PendingPersistence<Value> = {
  value: Value
  persist: (value: Value) => void
}

type Options<Value> = {
  controller: EditorPersistenceFlushController
  noteUuid: string
  persist: (value: Value) => void
  disabled?: boolean
  delayMs?: number
}

/**
 * Debounces custom-editor persistence while making the trailing value visible to
 * the NoteViewController lifecycle flush path. A pending entry captures the
 * persist callback that belonged to its note, so a note/controller change flushes
 * the old value to the old note rather than leaking it into the next one.
 */
export function useEditorPersistenceDebounce<Value>({
  controller,
  noteUuid,
  persist,
  disabled = false,
  delayMs = CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS,
}: Options<Value>): (value: Value) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = useRef<PendingPersistence<Value> | undefined>(undefined)

  const flush = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) {
      return
    }

    pendingRef.current = undefined
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }

    pending.persist(pending.value)
  }, [])

  const hasPending = useCallback(() => pendingRef.current !== undefined, [])

  const schedule = useCallback(
    (value: Value) => {
      if (disabled) {
        return
      }

      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
      }

      pendingRef.current = { value, persist }
      timerRef.current = setTimeout(flush, delayMs)
    },
    [delayMs, disabled, flush, persist],
  )

  useEffect(() => {
    return controller.registerEditorFlush(flush, hasPending)
  }, [controller, flush, hasPending])

  useEffect(() => {
    return () => {
      flush()
    }
  }, [controller, flush, noteUuid])

  return schedule
}
