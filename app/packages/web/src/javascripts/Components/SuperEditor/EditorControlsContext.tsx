import { createContext, ReactNode, SetStateAction, useContext, useMemo } from 'react'
import type { CommentAnchor } from '@/Comments/comments'

/** Ephemeral UI state lives above replaceable Lexical composers, scoped to the
 * exact note/session/encryption identity. Drafts never enter shared note data. */
export function createEditorControlsState(identity?: object) {
  let snapshot: {
    tabId: string | null
    commentTarget: string | undefined
    commentAnchor?: CommentAnchor
    commentsOpen: boolean
    commentsCollapsed: boolean
    commentsExpanded: boolean
    commentsWidth: number
  } = {
    tabId: null,
    commentTarget: undefined,
    commentsOpen: false,
    commentsCollapsed: false,
    commentsExpanded: false,
    commentsWidth: 320,
  }
  const listeners = new Set<() => void>()
  let existingCommentsRevealed = false
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
      if (commentTarget === snapshot.commentTarget && !snapshot.commentAnchor) {
        return
      }
      snapshot = { ...snapshot, commentTarget, commentAnchor: undefined }
      listeners.forEach((listener) => listener())
    },
    openComments: (anchor?: CommentAnchor) => {
      snapshot = {
        ...snapshot,
        commentsOpen: true,
        commentsCollapsed: false,
        ...(anchor
          ? { commentAnchor: anchor, commentTarget: anchor.kind === 'checklist' ? anchor.todoId : undefined }
          : {}),
      }
      listeners.forEach((listener) => listener())
    },
    revealExistingComments: () => {
      if (existingCommentsRevealed) {
        return
      }
      existingCommentsRevealed = true
      if (!snapshot.commentsOpen) {
        snapshot = { ...snapshot, commentsOpen: true, commentsCollapsed: false }
        listeners.forEach((listener) => listener())
      }
    },
    setCommentsLayout: (
      patch: Partial<
        Pick<typeof snapshot, 'commentsOpen' | 'commentsCollapsed' | 'commentsExpanded' | 'commentsWidth'>
      >,
    ) => {
      const next = { ...snapshot, ...patch }
      next.commentsWidth = Math.max(240, Math.min(600, Number.isFinite(next.commentsWidth) ? next.commentsWidth : 320))
      if (
        Object.keys(patch).every((key) => snapshot[key as keyof typeof snapshot] === next[key as keyof typeof snapshot])
      ) {
        return
      }
      snapshot = next
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
