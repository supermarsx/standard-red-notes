import { useEffect, useRef } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { captureEditorResume, captureEditorResumeScroll, restoreEditorResume } from './EditorResumeState'
import { readEditorResume, writeEditorResume } from './EditorResumeStorage'

/** Local view state belongs to the actual interactive canonical editor, never a detached owner. */
export function EditorResumePlugin({ storageKey, ready }: { storageKey: string; ready: boolean }) {
  const [editor] = useLexicalComposerContext()
  const restored = useRef(false)
  const stagedSelection = useRef(false)

  useEffect(() => {
    if (!ready) {
      return
    }
    let saved = readEditorResume(storageKey)
    let lastLiveScroll = saved?.scroll
    let frame: number | undefined
    let disposed = false
    let lastInteractionAt = 0
    let restoring = false
    let changedBeforeRestore = false
    const view = editor.getRootElement()?.ownerDocument.defaultView ?? window
    const capture = () => {
      if (!lastInteractionAt) {
        return
      }
      const root = editor.getRootElement()
      if (!root?.isConnected || !root.hasChildNodes()) {
        return
      }
      const state = captureEditorResume(editor, saved)
      if (state) {
        lastLiveScroll = state.scroll
        state.lastInteractionAt = lastInteractionAt
        saved = state
        writeEditorResume(storageKey, state)
      }
    }
    const scheduleCapture = () => {
      if (!disposed && restored.current && frame === undefined) {
        frame = view.requestAnimationFrame(() => {
          frame = undefined
          capture()
        })
      }
    }
    const interact = (event: Event) => {
      const root = editor.getRootElement()
      if (!root?.isConnected || !root.hasChildNodes()) {
        return
      }
      if ((event.type === 'scroll' || event.type === 'focusin') && !view.document.hasFocus()) {
        return
      }
      if (event.type === 'focusin' && stagedSelection.current && saved) {
        stagedSelection.current = false
        // Native focus can clamp the viewport to the initial empty selection
        // before focusin. Preserve the most recent intentional local viewport,
        // which may differ from the originally loaded bookmark after scrolling.
        restoreEditorResume(editor, { ...saved, scroll: lastLiveScroll ?? saved.scroll })
      }
      if (!restoring) {
        // Lexical empties the old root before root listeners run. Keep the
        // viewport while it still has content, before the browser clamps it.
        lastLiveScroll = captureEditorResumeScroll(root)
        if (!restored.current && event.type !== 'focusin') {
          changedBeforeRestore = true
        }
        lastInteractionAt = Math.max(Date.now(), lastInteractionAt + 1)
        scheduleCapture()
      }
    }
    const unregisterRoot = editor.registerRootListener((root, previous) => {
      if (previous && restored.current && lastInteractionAt) {
        const state = captureEditorResume(editor, saved, previous)
        if (state) {
          if (lastLiveScroll) {
            state.scroll = lastLiveScroll
          }
          state.lastInteractionAt = lastInteractionAt
          saved = state
          writeEditorResume(storageKey, state)
        }
      }
      for (const event of ['pointerdown', 'keydown', 'focusin', 'beforeinput', 'scroll']) {
        previous?.removeEventListener(event, interact)
        root?.addEventListener(event, interact, { passive: true })
      }
      if (root && !restored.current) {
        // Canonical-ready can precede the binding's DOM commit. Wait for its paint.
        frame = view.requestAnimationFrame(() => {
          frame = undefined
          if (disposed) {
            return
          }
          restored.current = true
          if (saved && !changedBeforeRestore) {
            restoring = true
            const focused = root.contains(root.ownerDocument.activeElement)
            stagedSelection.current = Boolean(saved.selection && !focused)
            // A nonfocused internal range can be focused by a later Yjs update.
            // Keep it staged until the user really enters this editor instead.
            restoreEditorResume(editor, saved, { selection: focused })
            frame = view.requestAnimationFrame(() => {
              frame = undefined
              restoring = false
            })
          } else if (lastInteractionAt) {
            capture()
          }
        })
      }
    })
    const outer = editor.getRootElement()?.closest('.editor-scroller')
    outer?.addEventListener('scroll', interact, { passive: true })
    const unregisterUpdate = editor.registerUpdateListener(() => {
      if (restored.current && lastInteractionAt) {
        scheduleCapture()
      }
    })
    const flush = () => {
      if (restored.current) {
        capture()
      }
    }
    view.addEventListener('pagehide', flush)
    view.addEventListener('beforeunload', flush)
    return () => {
      disposed = true
      if (frame !== undefined) {
        view.cancelAnimationFrame(frame)
      }
      flush()
      unregisterRoot()
      unregisterUpdate()
      for (const event of ['pointerdown', 'keydown', 'focusin', 'beforeinput', 'scroll']) {
        editor.getRootElement()?.removeEventListener(event, interact)
      }
      outer?.removeEventListener('scroll', interact)
      view.removeEventListener('pagehide', flush)
      view.removeEventListener('beforeunload', flush)
    }
  }, [editor, ready, storageKey])

  return null
}
