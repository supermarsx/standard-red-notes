import { ReactElement, useEffect, useMemo, useState } from 'react'
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

type Row = {
  key: string
  todoId?: string
  text: string
  checked: boolean
  pinned: boolean
  priority: ChecklistPriority
}
const priorityRank = { high: 0, normal: 1, low: 2 }

/** A separate task view; sorting this panel never reorders the encrypted document. */
export function ChecklistPanel({ note }: { note: SNNote }): ReactElement {
  const [editor] = useLexicalComposerContext()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [editable, setEditable] = useState(editor.isEditable())
  const [selected, setSelected] = useState<string>()
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
    const stop = editor.registerUpdateListener(refresh)
    const stopEditable = editor.registerEditableListener(setEditable)
    return () => {
      stop()
      stopEditable()
    }
  }, [editor])
  useEffect(() => {
    setSelected(undefined)
  }, [note.uuid])
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
    editor.update(() => {
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
    })
  }
  const showComments = (row: Row) => {
    if (row.todoId) {
      setSelected(row.todoId)
      return
    }
    if (!editor.isEditable()) {
      return
    }
    editor.update(() => {
      if (!editor.isEditable()) {
        return
      }
      const item = $getNodeByKey(row.key)
      if ($isListItemNode(item) && $isChecklistItemNode(item)) {
        setSelected($ensureChecklistTodoId(item))
      }
    })
  }
  return (
    <section className="border-border border-b p-2 text-sm" aria-label="Checklist and comments">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Checklist &amp; comments {rows.length ? `(${rows.filter((row) => row.checked).length}/${rows.length})` : ''}
      </button>
      {open && (
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          <p className="text-passive-1 text-xs">Pinned tasks first, then priority. Note order stays unchanged.</p>
          {ordered.map((row) => (
            <div key={row.key} className="flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Complete ${row.text}`}
                checked={row.checked}
                disabled={!editable}
                onChange={(event) => change(row.key, { checked: event.target.checked })}
              />
              <span className={row.checked ? 'line-through' : ''}>{row.text}</span>
              <button
                type="button"
                aria-pressed={row.pinned}
                disabled={!editable}
                onClick={() => change(row.key, { pinned: !row.pinned })}
              >
                {row.pinned ? 'Unpin' : 'Pin'}
              </button>
              <select
                aria-label={`Priority for ${row.text}`}
                disabled={!editable}
                value={row.priority}
                onChange={(event) => change(row.key, { priority: event.target.value as ChecklistPriority })}
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
              <button type="button" disabled={!row.todoId && !editable} onClick={() => showComments(row)}>
                Comments
              </button>
            </div>
          ))}
          {rows.length === 0 && <p className="text-passive-1 text-xs">Add a checklist to manage its tasks here.</p>}
          <button type="button" onClick={() => setSelected(undefined)}>
            Whole-note comments
          </button>
          {selected && !selectedRow ? (
            <p className="text-passive-1 text-xs">This task is no longer in the note.</p>
          ) : (
            <CommentsPanel
              key={`${note.uuid}:${selected ?? 'note'}`}
              note={note}
              anchor={
                selectedRow?.todoId
                  ? { kind: 'checklist', todoId: selectedRow.todoId, snippet: selectedRow.text.slice(0, 512) }
                  : undefined
              }
            />
          )}
        </div>
      )}
    </section>
  )
}
