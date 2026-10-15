import { ReactElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getRoot, $isElementNode, LexicalNode } from 'lexical'
import { $isListItemNode } from '@lexical/list'
import { SNNote } from '@standardnotes/snjs'
import CommentsPanel from '@/Components/Comments/CommentsPanel'
import {
  $ensureChecklistTodoId,
  $getChecklistFlags,
  $getChecklistTodoId,
  $isChecklistItemNode,
  $getChecklistOccurrenceSummary,
  $setChecklistFlags,
  ChecklistPriority,
} from '../Lexical/Nodes/ChecklistItemNode'
import { $applyChecklistItemChecked } from './ChecklistEditorMutations'
import { useEditorControlsState } from '../EditorControlsContext'

type Row = {
  key: string
  todoId?: string
  text: string
  checked: boolean
  pinned: boolean
  priority: ChecklistPriority
}
const priorityRank = { high: 0, normal: 1, low: 2 }

/** Ribbon sections share task identity; sorting this view never reorders the document. */
export function ChecklistPanel({
  note,
  activeSection,
  onOpenReview,
  flushChanges,
}: {
  note: SNNote
  activeSection: 'checklist' | 'review' | null
  onOpenReview: () => void
  flushChanges?: () => void
}): ReactElement {
  const [editor] = useLexicalComposerContext()
  const [reviewVisited, setReviewVisited] = useState(activeSection === 'review')
  const [rows, setRows] = useState<Row[]>([])
  const [editable, setEditable] = useState(editor.isEditable())
  const controlsState = useEditorControlsState()
  const { commentTarget: selected } = useSyncExternalStore(controlsState.subscribe, controlsState.getSnapshot)
  const setSelected = controlsState.setCommentTarget
  useEffect(() => {
    const refresh = () =>
      editor.getEditorState().read(() => {
        const next: Row[] = []
        const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse()
        let remaining = 50_000
        while (stack.length && remaining-- > 0) {
          const node = stack.pop()!
          if ($isListItemNode(node) && $isChecklistItemNode(node) && !$getChecklistOccurrenceSummary(node)) {
            // Nested list text belongs to its own row, not its parent's label.
            const text = node
              .getChildren()
              .filter((child) => !($isElementNode(child) && child.getType() === 'list'))
              .map((child) => child.getTextContent())
              .join('')
              .trim()
            if (text) {
              next.push({
                key: node.getKey(),
                todoId: $getChecklistTodoId(node),
                text,
                checked: node.getChecked() === true,
                ...$getChecklistFlags(node),
              })
            }
          }
          if ($isElementNode(node)) {
            stack.push(...node.getChildren().reverse())
          }
        }
        setRows(next)
      })
    refresh()
    const stop = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size || dirtyLeaves.size) {
        refresh()
      }
    })
    const stopEditable = editor.registerEditableListener(setEditable)
    return () => {
      stop()
      stopEditable()
    }
  }, [editor])
  useEffect(() => {
    if (activeSection === 'review') {
      setReviewVisited(true)
    }
  }, [activeSection])
  const ordered = useMemo(
    () =>
      [...rows].sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) || priorityRank[left.priority] - priorityRank[right.priority],
      ),
    [rows],
  )
  const selectedRow = selected ? rows.find((row) => row.todoId === selected) : undefined
  const change = (key: string, patch: { pinned?: boolean; priority?: ChecklistPriority; checked?: boolean }) => {
    if (!editor.isEditable()) {
      return
    }
    editor.update(
      () => {
        if (!editor.isEditable()) {
          return
        }
        const item = $getNodeByKey(key)
        if (!$isListItemNode(item) || !$isChecklistItemNode(item)) {
          return
        }
        $ensureChecklistTodoId(item)
        if (patch.checked !== undefined) {
          $applyChecklistItemChecked(item, patch.checked)
        }
        $setChecklistFlags(item, patch)
      },
      { onUpdate: flushChanges },
    )
  }
  const showComments = (row: Row) => {
    if (row.todoId) {
      setSelected(row.todoId)
      onOpenReview()
      return
    }
    if (!editor.isEditable()) {
      return
    }
    editor.update(
      () => {
        if (!editor.isEditable()) {
          return
        }
        const item = $getNodeByKey(row.key)
        if ($isListItemNode(item) && $isChecklistItemNode(item)) {
          setSelected($ensureChecklistTodoId(item))
          onOpenReview()
        }
      },
      { onUpdate: flushChanges },
    )
  }
  const controlClassName =
    'border-border bg-default hover:bg-contrast focus-visible:ring-info rounded border px-2 py-1 text-xs focus-visible:ring-2 disabled:opacity-50'
  return (
    <>
      <section hidden={activeSection !== 'checklist'} aria-label="Checklist tasks" className="w-full p-2 text-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium">
            Tasks · {rows.filter((row) => row.checked).length}/{rows.length} completed
          </span>
          <span className="text-passive-1 text-xs">Pinned first, then priority</span>
        </div>
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {ordered.map((row) => (
            <div key={row.key} className="border-border flex flex-wrap items-center gap-2 rounded border p-2">
              <input
                type="checkbox"
                aria-label={`Complete ${row.text}`}
                checked={row.checked}
                disabled={!editable}
                onChange={(event) => change(row.key, { checked: event.target.checked })}
              />
              <span className={`min-w-24 flex-1 break-words ${row.checked ? 'line-through' : ''}`}>{row.text}</span>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={controlClassName}
                  aria-pressed={row.pinned}
                  disabled={!editable}
                  onClick={() => change(row.key, { pinned: !row.pinned })}
                >
                  {row.pinned ? 'Unpin' : 'Pin'}
                </button>
                <select
                  className={controlClassName}
                  aria-label={`Priority for ${row.text}`}
                  disabled={!editable}
                  value={row.priority}
                  onChange={(event) => change(row.key, { priority: event.target.value as ChecklistPriority })}
                >
                  <option value="high">⚑ High</option>
                  <option value="normal">Normal</option>
                  <option value="low">⚑ Low</option>
                </select>
                <button
                  type="button"
                  className={controlClassName}
                  disabled={!row.todoId && !editable}
                  onClick={() => showComments(row)}
                >
                  Comments
                </button>
              </div>
            </div>
          ))}
          {rows.length === 0 && <p className="text-passive-1 text-xs">Add a checklist to manage its tasks here.</p>}
        </div>
      </section>
      <section hidden={activeSection !== 'review'} aria-label="Review comments" className="w-full p-2 text-sm">
        <label className="mb-2 flex flex-wrap items-center gap-2 font-medium">
          Comments for
          <select
            className="border-border bg-default max-w-full min-w-0 rounded border px-2 py-1 font-normal"
            aria-label="Comment target"
            value={selectedRow?.key ?? (selected ? 'removed' : 'note')}
            onChange={(event) => {
              if (event.target.value === 'note') {
                setSelected(undefined)
              } else {
                const row = rows.find((candidate) => candidate.key === event.target.value)
                if (row) {
                  showComments(row)
                }
              }
            }}
          >
            <option value="note">Whole note</option>
            {selected && !selectedRow && <option value="removed">Removed task</option>}
            {rows.map((row) => (
              <option key={row.key} value={row.key} disabled={!row.todoId && !editable}>
                {row.text.slice(0, 100)}
              </option>
            ))}
          </select>
        </label>
        <div className="max-h-64 overflow-y-auto">
          {selected && !selectedRow ? (
            <p className="text-passive-1 text-xs">This task is no longer in the note.</p>
          ) : reviewVisited ? (
            <CommentsPanel
              key={`${note.uuid}:${selected ? `checklist:${selected}` : 'note'}`}
              note={note}
              anchor={
                selectedRow?.todoId
                  ? { kind: 'checklist', todoId: selectedRow.todoId, snippet: selectedRow.text.slice(0, 512) }
                  : undefined
              }
            />
          ) : null}
        </div>
      </section>
    </>
  )
}
