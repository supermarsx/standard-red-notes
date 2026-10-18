import Dropdown from '@/Components/Dropdown/Dropdown'
import { Component, lazy, ReactNode, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getRoot, $getNodeByKey, $isElementNode, LexicalNode } from 'lexical'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { PRIVATE_COMMENT_CONTENT_TYPE } from '@/Comments/PrivateCommentOperations'
import { readPrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { canUseCommentRange, isBoundCommentRange } from '@/Comments/CommentRangeAnchor'
import { useEditorControlsState } from './EditorControlsContext'
import { $getChecklistTodoId, $isChecklistItemNode } from './Lexical/Nodes/ChecklistItemNode'
import type { CommentAnchor } from '@/Comments/comments'
import { captureAssistantCommentTarget, type CapturedCommentTarget } from '@/Comments/CommentTargets'
import { lexicalCommentBlockRanges } from './Plugins/CommentsPlugin/LexicalCommentTargets'

const CommentsPanel = lazy(() => import('@/Components/Comments/CommentsPanel'))

/** A failed comment view must never take the document editor down with it. */
class CommentsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        Comments could not be loaded.{' '}
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Retry comments
        </button>
      </p>
    ) : (
      this.props.children
    )
  }
}

export function CommentsSidebar({ note }: { note: SNNote }) {
  const [editor] = useLexicalComposerContext()
  const application = useApplication()
  const controls = useEditorControlsState()
  const layout = useSyncExternalStore(controls.subscribe, controls.getSnapshot)
  const [visited, setVisited] = useState(layout.commentsOpen)
  const [tasks, setTasks] = useState<{ todoId: string; text: string; key: string }[]>([])
  const [navigationStatus, setNavigationStatus] = useState('')
  const capturedRef = useRef<{ anchor: CommentAnchor; snapshot: string; capture?: CapturedCommentTarget } | undefined>(
    undefined,
  )
  useEffect(() => {
    let revealed = false
    const reveal = () => {
      if (revealed) {
        return
      }
      const current = application.items.findItem<SNNote>(note.uuid)
      if (!current || !application.isAuthorizedToRenderItem(current)) {
        return
      }
      if (
        readPrivateNoteComments(application, note.uuid).length > 0 ||
        readDisplayNoteComments(application, current).comments.length > 0
      ) {
        revealed = true
        controls.revealExistingComments()
      }
    }
    reveal()
    const stopItems = application.items.addObserver(
      [
        ContentType.TYPES.Note,
        ContentType.TYPES.UserPrefs,
        ContentType.TYPES.TrustedContact,
        PRIVATE_COMMENT_CONTENT_TYPE,
      ],
      ({ changed, inserted, removed, unerrored }) => {
        if (
          [...changed, ...inserted, ...removed, ...unerrored].some(
            (item) => item.uuid === note.uuid || item.content_type !== ContentType.TYPES.Note,
          )
        ) {
          reveal()
        }
      },
    )
    const stopPreferences = application.addEventObserver(async () => reveal(), ApplicationEvent.PreferencesChanged)
    return () => {
      stopItems()
      stopPreferences()
    }
  }, [application, controls, note.uuid])
  useEffect(() => {
    if (layout.commentsOpen) {
      setVisited(true)
    }
  }, [layout.commentsOpen])
  useEffect(() => {
    if (!layout.commentsOpen) {
      return
    }
    const refresh = () =>
      editor.getEditorState().read(() => {
        const next: typeof tasks = []
        const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse()
        let remaining = 50_000
        while (stack.length && remaining-- > 0) {
          const node = stack.pop()!
          if ($isChecklistItemNode(node)) {
            const todoId = $getChecklistTodoId(node)
            if (todoId) {
              next.push({ todoId, key: node.getKey(), text: node.getTextContent().slice(0, 100) })
            }
          }
          if ($isElementNode(node)) {
            stack.push(...node.getChildren().reverse())
          }
        }
        const counts = new Map<string, number>()
        for (const row of next) {
          counts.set(row.todoId, (counts.get(row.todoId) ?? 0) + 1)
        }
        setTasks(next.filter((row) => counts.get(row.todoId) === 1))
      })
    refresh()
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size || dirtyLeaves.size) {
        refresh()
      }
    })
  }, [editor, layout.commentsOpen])
  if (!visited && !layout.commentsOpen) {
    return null
  }
  const task = layout.commentTarget ? tasks.find((row) => row.todoId === layout.commentTarget) : undefined
  const anchor =
    layout.commentAnchor ?? (task ? { kind: 'checklist' as const, todoId: task.todoId, snippet: task.text } : undefined)
  if (anchor && capturedRef.current?.anchor !== anchor) {
    capturedRef.current = { anchor, snapshot: JSON.stringify(editor.getEditorState().toJSON()) }
  }
  const control =
    'rounded border border-border px-2 py-1 text-xs hover:bg-contrast focus-visible:ring-2 focus-visible:ring-info'
  const navigate = (target: CommentAnchor) => {
    let key: string | undefined
    editor.getEditorState().read(() => {
      if (target.kind === 'checklist') {
        key = tasks.find((row) => row.todoId === target.todoId)?.key
      } else if (target.kind === 'super') {
        if (target.exactRange) {
          const range = target.exactRange
          if (canUseCommentRange(target) && $getRoot().getTextContent().slice(range.start, range.end) === range.text) {
            try {
              key = lexicalCommentBlockRanges().find((block) => block.start < range.end && block.end > range.start)?.key
            } catch {
              // Unsupported projections cannot safely relocate an exact selection.
            }
          }
          return
        }
        if (isBoundCommentRange(target)) {
          return
        }
        const node = $getNodeByKey(target.blockKey)
        const snippet = target.snippet?.replace(/…$/, '')
        if (node?.isAttached() && (!snippet || node.getTextContent().includes(snippet))) {
          key = node.getKey()
        } else if (snippet) {
          const matches = $getRoot()
            .getChildren()
            .filter((child) => child.getTextContent().includes(snippet))
          if (matches.length === 1) {
            key = matches[0].getKey()
          }
        }
      }
    })
    const element = key ? editor.getElementByKey(key) : null
    setNavigationStatus(element ? '' : 'The commented text has moved or is no longer in this note.')
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.animate?.([{ outline: '2px solid var(--sn-stylekit-info-color)' }, { outline: '2px solid transparent' }], {
      duration: 1400,
    })
  }
  return (
    <aside
      aria-label="Comments sidebar"
      hidden={!layout.commentsOpen}
      className={`border-border bg-default relative flex min-h-0 max-w-[calc(100%_-_240px)] shrink-0 flex-col border-l max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:max-w-[85%] ${layout.commentsOpen ? '' : '!hidden'}`}
      style={{
        width: layout.commentsCollapsed ? 44 : layout.commentsExpanded ? 600 : layout.commentsWidth,
        overflow: 'hidden',
      }}
    >
      {!layout.commentsCollapsed && (
        <div
          role="separator"
          aria-label="Resize comments sidebar"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={600}
          aria-valuenow={layout.commentsExpanded ? 600 : layout.commentsWidth}
          tabIndex={0}
          className="focus-visible:bg-info absolute top-0 bottom-0 left-0 z-10 w-2 cursor-col-resize touch-none"
          onKeyDown={(event) => {
            const widths: Record<string, number> = {
              ArrowLeft: layout.commentsWidth + 24,
              ArrowRight: layout.commentsWidth - 24,
              Home: 240,
              End: 600,
            }
            if (event.key in widths) {
              event.preventDefault()
              controls.setCommentsLayout({ commentsExpanded: false, commentsWidth: widths[event.key] })
            }
          }}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
            }
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              return
            }
            const edge = event.currentTarget.parentElement!.getBoundingClientRect().right
            controls.setCommentsLayout({ commentsExpanded: false, commentsWidth: edge - event.clientX })
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
        />
      )}
      <header className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b p-2 pl-3">
        {!layout.commentsCollapsed && <strong className="flex-1 text-sm">Comments</strong>}
        <button
          type="button"
          className={control}
          aria-label={layout.commentsCollapsed ? 'Restore comments sidebar' : 'Collapse comments sidebar'}
          onClick={() => controls.setCommentsLayout({ commentsCollapsed: !layout.commentsCollapsed })}
        >
          {layout.commentsCollapsed ? '»' : '«'}
        </button>
        {!layout.commentsCollapsed && (
          <>
            <button
              type="button"
              className={control}
              aria-label={layout.commentsExpanded ? 'Restore comments width' : 'Expand comments sidebar'}
              onClick={() => controls.setCommentsLayout({ commentsExpanded: !layout.commentsExpanded })}
            >
              {layout.commentsExpanded ? 'Restore' : 'Expand'}
            </button>
            <button
              type="button"
              className={control}
              aria-label="Close comments sidebar"
              onClick={() => controls.setCommentsLayout({ commentsOpen: false })}
            >
              ×
            </button>
          </>
        )}
      </header>
      <div hidden={layout.commentsCollapsed} className="min-h-0 flex-1 overflow-y-auto p-3">
        {navigationStatus && (
          <p role="status" className="mb-2 text-xs">
            {navigationStatus}
          </p>
        )}
        {layout.commentTarget && !task ? (
          <p className="text-sm">This task is no longer in the note.</p>
        ) : (
          <CommentsBoundary key={note.uuid}>
            <Suspense fallback={<p role="status">Loading comments…</p>}>
              <CommentsPanel
                key={note.uuid}
                note={note}
                anchor={anchor}
                onNavigate={navigate}
                validateTarget={(visibility, replying) => {
                  const noteTarget = captureAssistantCommentTarget(application, note.uuid, 'note')
                  noteTarget.assertCurrent({ sharedMutation: visibility === 'collaborative' })
                  if (!replying && anchor) {
                    const captured = capturedRef.current
                    if (
                      !captured ||
                      captured.anchor !== anchor ||
                      (anchor.kind === 'super' &&
                        captured.snapshot !== JSON.stringify(editor.getEditorState().toJSON()))
                    ) {
                      throw new Error(
                        'The note changed after the comment target was captured. Select the target again before saving.',
                      )
                    }
                    captured.capture?.assertCurrent({ sharedMutation: visibility === 'collaborative' })
                  }
                }}
                targetControl={
                  <Dropdown
                    portal
                    label="Comment target"
                    popoverPlacement="bottom-start"
                    classNameOverride={{
                      button: '!min-w-0 !px-2 !py-1 [&_div]:!text-xs',
                      wrapper: 'max-w-full text-xs',
                    }}
                    value={
                      layout.commentTarget ??
                      (layout.commentAnchor?.kind === 'super' ? (layout.commentAnchor.target ?? 'selection') : 'note')
                    }
                    onChange={(value) => {
                      if (value === 'selection' || value === 'section') {
                        try {
                          const capture = captureAssistantCommentTarget(application, note.uuid, value)
                          if (!capture.anchor) {
                            throw new Error('Select the target in the live editor first.')
                          }
                          capturedRef.current = {
                            anchor: capture.anchor,
                            snapshot: JSON.stringify(editor.getEditorState().toJSON()),
                            capture,
                          }
                          controls.openComments(capture.anchor)
                          setNavigationStatus('')
                        } catch (error) {
                          setNavigationStatus(
                            error instanceof Error ? error.message : 'The comment target is unavailable.',
                          )
                        }
                      } else {
                        controls.setCommentTarget(value === 'note' ? undefined : value)
                      }
                    }}
                    items={[
                      { value: 'note', label: 'Whole note' },
                      { value: 'selection', label: 'Selected text' },
                      { value: 'section', label: 'Current section' },
                      ...tasks.map((row) => ({ value: row.todoId, label: `Item: ${row.text}` })),
                    ]}
                  />
                }
              />
            </Suspense>
          </CommentsBoundary>
        )}
      </div>
    </aside>
  )
}
