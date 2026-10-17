import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantChatComposerPatch, AssistantChatComposerState } from '@/Assistant/assistantChatComposerState'
import type { AssistantSharedChatBinding } from '@/Assistant/assistantSyncedChats'

const fields = ['draft', 'context', 'toolPermissionMode'] as const
type Field = (typeof fields)[number]
const keys = (patch: AssistantChatComposerPatch) => fields.filter((field) => Object.hasOwn(patch, field))

export function useAssistantComposerSync({
  identity,
  binding,
  onRemote,
}: {
  identity: string
  binding?: AssistantSharedChatBinding
  onRemote: (patch: AssistantChatComposerPatch) => void
}) {
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const receive = useRef(onRemote)
  receive.current = onRemote
  const [failure, setFailure] = useState<{ identity: string; error: unknown }>()
  const state = useMemo(
    () => ({
      identity,
      binding: undefined as AssistantSharedChatBinding | undefined,
      active: true,
      pending: {} as AssistantChatComposerPatch,
      incoming: {} as AssistantChatComposerState,
      baseline: {} as Partial<Record<Field, number>>,
      baselineValue: {} as Partial<Record<Field, string>>,
      revisions: { draft: 0, context: 0, toolPermissionMode: 0 },
      debounce: undefined as ReturnType<typeof setTimeout> | undefined,
      deadline: undefined as ReturnType<typeof setTimeout> | undefined,
      running: undefined as Promise<boolean> | undefined,
    }),
    [identity],
  )
  state.binding = binding
  const clearTimers = useCallback(() => {
    clearTimeout(state.debounce)
    clearTimeout(state.deadline)
    state.debounce = state.deadline = undefined
  }, [state])
  const applyIncoming = useCallback(() => {
    if (!state.active || currentIdentity.current !== state.identity) {
      return
    }
    const patch: AssistantChatComposerPatch = {}
    for (const field of fields) {
      const incoming = state.incoming[field]
      if (
        !incoming ||
        Object.hasOwn(state.pending, field) ||
        incoming.updatedAt < (state.baseline[field] ?? -1) ||
        (incoming.updatedAt === state.baseline[field] && JSON.stringify(incoming.value) === state.baselineValue[field])
      ) {
        continue
      }
      state.baseline[field] = incoming.updatedAt
      state.baselineValue[field] = JSON.stringify(incoming.value)
      Object.assign(patch, { [field]: incoming.value })
    }
    if (keys(patch).length) {
      receive.current(patch)
    }
  }, [state])
  const flush = useCallback((): Promise<boolean> => {
    clearTimers()
    if (state.running) {
      return state.running
    }
    if (currentIdentity.current !== state.identity) {
      return Promise.resolve(false)
    }
    if (!keys(state.pending).length) {
      return Promise.resolve(true)
    }
    const checkpoint = state.binding?.checkpointComposer
    if (!state.binding?.ready || !checkpoint) {
      if (state.active) {
        setFailure({ identity, error: new Error('Chat settings are waiting for synced storage.') })
      }
      return Promise.resolve(false)
    }
    // Capture the binding for this identity: later renders must never redirect an old write.
    state.running = Promise.resolve().then(async () => {
      try {
        while (keys(state.pending).length && currentIdentity.current === state.identity) {
          if (!state.binding?.ready) {
            throw new Error('Chat settings are waiting for synced storage.')
          }
          const patch = { ...state.pending }
          const revisions = { ...state.revisions }
          const saved = await checkpoint(patch)
          for (const field of keys(patch)) {
            const acknowledged = saved?.composer?.[field]
            // A void acknowledgement has no server clock: suppress only the remote snapshot
            // already observed while this write was pending, never a future incoming update.
            state.baseline[field] = Math.max(
              state.baseline[field] ?? -1,
              acknowledged?.updatedAt ?? state.incoming[field]?.updatedAt ?? -1,
            )
            state.baselineValue[field] = JSON.stringify(
              acknowledged ? patch[field] : (state.incoming[field]?.value ?? patch[field]),
            )
            if (acknowledged && acknowledged.updatedAt >= (state.incoming[field]?.updatedAt ?? -1)) {
              Object.assign(state.incoming, { [field]: acknowledged })
            }
            if (state.revisions[field] === revisions[field]) {
              delete state.pending[field]
            }
          }
          applyIncoming()
        }
        if (state.active && currentIdentity.current === state.identity) {
          setFailure(undefined)
        }
        return currentIdentity.current === state.identity
      } catch (error) {
        if (state.active && currentIdentity.current === state.identity) {
          setFailure({ identity, error })
        }
        return false
      } finally {
        state.running = undefined
      }
    })
    return state.running
  }, [applyIncoming, clearTimers, identity, state])
  const update = useCallback(
    (patch: AssistantChatComposerPatch) => {
      if (!state.active || currentIdentity.current !== state.identity || !state.binding?.checkpointComposer) {
        return
      }
      for (const field of keys(patch)) {
        state.revisions[field]++
      }
      Object.assign(state.pending, patch)
      clearTimeout(state.debounce)
      state.debounce = setTimeout(() => void flush(), 400)
      state.deadline ??= setTimeout(() => void flush(), 2000)
    },
    [flush, state],
  )

  useEffect(() => {
    for (const field of fields) {
      const incoming = binding?.history?.composer?.[field]
      if (incoming && incoming.updatedAt >= (state.incoming[field]?.updatedAt ?? -1)) {
        Object.assign(state.incoming, { [field]: incoming })
      }
    }
    applyIncoming()
  }, [applyIncoming, binding?.history?.composer, state])
  useEffect(() => {
    if (binding?.ready && keys(state.pending).length) {
      void flush()
    }
  }, [binding?.ready, flush, state])
  useEffect(() => {
    state.active = true
    const save = () => {
      void flush()
    }
    window.addEventListener('pagehide', save)
    window.addEventListener('online', save)
    window.addEventListener('focus', save)
    document.addEventListener('visibilitychange', save)
    return () => {
      state.active = false
      clearTimers()
      if (currentIdentity.current === state.identity) {
        save()
      }
      window.removeEventListener('pagehide', save)
      window.removeEventListener('online', save)
      window.removeEventListener('focus', save)
      document.removeEventListener('visibilitychange', save)
    }
  }, [clearTimers, flush, state])
  return { update, flush, error: failure?.identity === identity ? failure.error : undefined }
}
