export type AssistantActivityStatus = 'working' | 'reading' | 'editing'
export type AssistantActivity = {
  runId: string
  noteUuid: string
  userUuid?: string
  status: AssistantActivityStatus
}
export type RemoteAssistantActivity = AssistantActivity & { clientId: number; ownerName?: string }

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
const validStatus = (value: unknown): value is AssistantActivityStatus =>
  value === 'working' || value === 'reading' || value === 'editing'
const MAX_ACTIVITIES = 8

class AssistantPresenceRegistry {
  private local = new Map<symbol, AssistantActivity>()
  private remote = new Map<string, Map<symbol, RemoteAssistantActivity[]>>()
  private listeners = new Map<string, Set<() => void>>()

  start(activity: AssistantActivity): {
    update(noteUuid: string, status: AssistantActivityStatus): void
    dispose(): void
  } {
    const key = Symbol()
    if (
      validId(activity.runId) &&
      validId(activity.noteUuid) &&
      validStatus(activity.status) &&
      (activity.userUuid === undefined || validId(activity.userUuid)) &&
      this.local.size < 64
    ) {
      this.local.set(key, { ...activity })
      this.emit(activity.noteUuid)
    }
    return {
      update: (noteUuid, status) => {
        const previous = this.local.get(key)
        if (!previous || !validId(noteUuid) || !validStatus(status)) {
          return
        }
        if (previous.noteUuid === noteUuid && previous.status === status) {
          return
        }
        this.local.set(key, { ...previous, noteUuid, status })
        this.emit(previous.noteUuid)
        if (noteUuid !== previous.noteUuid) {
          this.emit(noteUuid)
        }
      },
      dispose: () => {
        const previous = this.local.get(key)
        if (previous) {
          this.local.delete(key)
          this.emit(previous.noteUuid)
        }
      },
    }
  }

  getLocal(noteUuid: string): AssistantActivity[] {
    return [...this.local.values()]
      .filter((entry) => entry.noteUuid === noteUuid)
      .slice(0, MAX_ACTIVITIES)
      .map((entry) => ({ ...entry }))
  }

  getRemote(noteUuid: string): RemoteAssistantActivity[] {
    const unique = new Map<string, RemoteAssistantActivity>()
    for (const entries of this.remote.get(noteUuid)?.values() ?? []) {
      for (const entry of entries) {
        const key = `${entry.userUuid}:${entry.runId}`
        if (unique.size < 64 && !unique.has(key)) {
          unique.set(key, { ...entry })
        }
      }
    }
    return [...unique.values()]
  }

  setRemote(noteUuid: string, source: symbol, entries: RemoteAssistantActivity[]): void {
    const sources = this.remote.get(noteUuid) ?? new Map<symbol, RemoteAssistantActivity[]>()
    const bounded = entries.slice(0, 64)
    const previous = sources.get(source)
    if ((!previous && !bounded.length) || JSON.stringify(previous) === JSON.stringify(bounded)) {
      return
    }
    if (entries.length) {
      sources.set(source, bounded)
      this.remote.set(noteUuid, sources)
    } else {
      sources.delete(source)
      if (!sources.size) {
        this.remote.delete(noteUuid)
      }
    }
    this.emit(noteUuid)
  }

  clearRemote(noteUuid: string, source: symbol): void {
    this.setRemote(noteUuid, source, [])
  }

  subscribe(noteUuid: string, listener: () => void): () => void {
    const listeners = this.listeners.get(noteUuid) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(noteUuid, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        this.listeners.delete(noteUuid)
      }
    }
  }

  private emit(noteUuid: string): void {
    this.listeners.get(noteUuid)?.forEach((listener) => {
      try {
        listener()
      } catch {
        /* Decoration must never interrupt a chat run or its cleanup. */
      }
    })
  }
}

export const AssistantPresence = new AssistantPresenceRegistry()

type State = Record<string, unknown>
export type AssistantActivityAwareness = {
  clientID: number
  getLocalState(): State | null
  setLocalStateField(field: string, value: unknown): void
  getStates(): Map<number, State>
  on(event: 'change', listener: () => void): void
  off(event: 'change', listener: () => void): void
}

/** Adds AI metadata to the existing human client. Never creates a client/caret/lease. */
export function bridgeAssistantPresence(
  awareness: AssistantActivityAwareness,
  noteUuid: string,
  userUuid: string,
): () => void {
  const source = Symbol()
  let publishing = false
  let disposed = false
  const publish = () => {
    if (publishing || disposed) {
      return
    }
    publishing = true
    try {
      const local = awareness.getLocalState()
      const metadata = local?.awarenessData as State | undefined
      if (metadata?.userUuid === userUuid) {
        const activity = AssistantPresence.getLocal(noteUuid)
          .filter((entry) => entry.userUuid === userUuid)
          .map(({ runId, status }) => ({ runId, status }))
        if (JSON.stringify(metadata.assistantActivity ?? []) !== JSON.stringify(activity)) {
          awareness.setLocalStateField('awarenessData', { ...metadata, assistantActivity: activity })
        }
      }
      const entries: RemoteAssistantActivity[] = []
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID || !Number.isSafeInteger(clientId) || clientId < 0) {
          return
        }
        const data = state?.awarenessData as State | undefined
        if (!validId(data?.userUuid) || !Array.isArray(data?.assistantActivity)) {
          return
        }
        for (const entry of data.assistantActivity.slice(0, MAX_ACTIVITIES)) {
          if (!entry || !validId(entry.runId) || !validStatus(entry.status) || entries.length >= 64) {
            continue
          }
          entries.push({
            noteUuid,
            userUuid: data.userUuid,
            clientId,
            runId: entry.runId,
            status: entry.status,
            ...(typeof state.name === 'string' ? { ownerName: state.name.slice(0, 128) } : {}),
          })
        }
      })
      AssistantPresence.setRemote(noteUuid, source, entries)
    } finally {
      publishing = false
    }
  }
  const unsubscribe = AssistantPresence.subscribe(noteUuid, publish)
  awareness.on('change', publish)
  publish()
  return () => {
    disposed = true
    unsubscribe()
    awareness.off('change', publish)
    const metadata = awareness.getLocalState()?.awarenessData as State | undefined
    if (metadata?.userUuid === userUuid && metadata.assistantActivity !== undefined) {
      const { assistantActivity: _removed, ...rest } = metadata
      awareness.setLocalStateField('awarenessData', rest)
    }
    AssistantPresence.clearRemote(noteUuid, source)
  }
}
