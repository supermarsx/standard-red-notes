import { createContext, ReactNode, SetStateAction, useContext, useMemo } from 'react'

/** Ephemeral UI state lives above replaceable Lexical composers, scoped to the
 * exact note/session/encryption identity. Drafts never enter shared note data. */
export function createEditorControlsState(identity?: object) {
  let snapshot: { tabId: string | null; commentTarget: string | undefined } = { tabId: null, commentTarget: undefined }
  const listeners = new Set<() => void>()
  return {
    identity,
    drafts: new Map<string, string>(),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setTab: (action: SetStateAction<string | null>) => {
      const tabId = typeof action === 'function' ? action(snapshot.tabId) : action
      if (tabId === snapshot.tabId) {
        return
      }
      snapshot = { ...snapshot, tabId }
      listeners.forEach((listener) => listener())
    },
    setCommentTarget: (commentTarget: string | undefined) => {
      if (commentTarget === snapshot.commentTarget) {
        return
      }
      snapshot = { ...snapshot, commentTarget }
      listeners.forEach((listener) => listener())
    },
  }
}

const EditorControlsContext = createContext<ReturnType<typeof createEditorControlsState> | null>(null)

export function EditorControlsProvider({ identity, children }: { identity: object; children: ReactNode }) {
  const state = useMemo(() => createEditorControlsState(identity), [identity])
  return <EditorControlsContext.Provider value={state}>{children}</EditorControlsContext.Provider>
}

export function useEditorControlsState() {
  const shared = useContext(EditorControlsContext)
  const fallback = useMemo(() => createEditorControlsState(), [])
  return shared ?? fallback
}
