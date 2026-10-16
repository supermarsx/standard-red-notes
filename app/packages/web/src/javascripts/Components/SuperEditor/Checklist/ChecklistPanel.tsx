import { ChecklistOrganizeMenu } from './ChecklistOrganizeMenu'
import Dropdown from '@/Components/Dropdown/Dropdown'
import ToolbarButton from '../Plugins/ToolbarPlugin/ToolbarButton'
import Icon from '@/Components/Icon/Icon'
import { ReactElement, useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getSelection, $isRangeSelection, $isElementNode, LexicalNode } from 'lexical'
import { $isListItemNode } from '@lexical/list'
import { SNNote } from '@standardnotes/snjs'
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
import { useApplicationOrNull } from '@/Components/ApplicationProvider'
import {
  $getChecklistPersonalTicks,
  $setChecklistPersonalTick,
  $isChecklistPerPerson,
  $setChecklistPerPerson,
  $getChecklistCheckedForUser,
} from './checklistPersonalTicks'

type Row = {
  key: string
  todoId?: string
  text: string
  checked: boolean
  pinned: boolean
  priority: ChecklistPriority
  ticks: string[]
  perPerson: boolean
}
function $selectedTask(node: LexicalNode | null): LexicalNode | null {
  while (node) {
    if ($isChecklistItemNode(node)) {
      return node
    }
    node = node.getParent()
  }
  return null
}

/** Compact ribbon controls follow the task under the caret, never a duplicate task list. */
export function ChecklistPanel({
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
  const application = useApplicationOrNull()
  const selfUuid = application?.sessions.getUser()?.uuid
  const [row, setRow] = useState<Row | null>(null)
  const selectedKey = useRef<string | null>(null)
  const [editable, setEditable] = useState(editor.isEditable())
  const controlsState = useEditorControlsState()
  const setSelected = controlsState.setCommentTarget
  useEffect(() => {
    const refresh = () =>
      editor.getEditorState().read(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          const anchor = $selectedTask(selection.anchor.getNode())
          const focus = $selectedTask(selection.focus.getNode())
          selectedKey.current = anchor && anchor.getKey() === focus?.getKey() ? anchor.getKey() : null
        } else if (selection) {
          selectedKey.current = null
        }
        // Toolbar focus can clear the range. Keep its last task until the caret
        // moves elsewhere; remote deletion still clears the controls immediately.
        const node = selectedKey.current ? $getNodeByKey(selectedKey.current) : null
        if (!$isListItemNode(node) || !$isChecklistItemNode(node) || $getChecklistOccurrenceSummary(node)) {
          setRow(null)
          return
        }
        const text = node
          .getChildren()
          .filter((child) => !($isElementNode(child) && child.getType() === 'list'))
          .map((child) => child.getTextContent())
          .join('')
          .trim()
        setRow({
          key: node.getKey(),
          todoId: $getChecklistTodoId(node),
          text: text || 'Untitled task',
          checked: $getChecklistCheckedForUser(node, selfUuid),
          ticks: $getChecklistPersonalTicks(node),
          perPerson: $isChecklistPerPerson(node),
          ...$getChecklistFlags(node),
        })
      })
    refresh()
    const stop = editor.registerUpdateListener(refresh)
    const stopEditable = editor.registerEditableListener(setEditable)
    return () => {
      stop()
      stopEditable()
    }
  }, [editor, selfUuid])
  const change = (
    key: string,
    patch: { pinned?: boolean; priority?: ChecklistPriority; checked?: boolean; perPerson?: boolean },
  ) => {
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
        if (patch.perPerson !== undefined) {
          $setChecklistPerPerson(item, patch.perPerson)
        }
        if (patch.checked !== undefined) {
          if ($isChecklistPerPerson(item)) {
            if (!selfUuid || application?.sessions.getUser()?.uuid !== selfUuid) {
              return
            }
            $setChecklistPersonalTick(item, selfUuid, patch.checked)
          } else {
            $applyChecklistItemChecked(item, patch.checked)
          }
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
  const tickName = (userId: string) => {
    if (userId === selfUuid) {
      return 'You'
    }
    return application?.contacts.findContact(userId)?.name || userId
  }
  const dropdownStyle = { button: '!min-w-0 !px-2 !py-1 !text-xs', wrapper: 'min-w-0 max-w-52' }
  return (
    <>
      <section
        hidden={activeSection !== 'checklist'}
        aria-label="Checklist tasks"
        className="super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-1 py-0.5 text-sm"
      >
        {row ? (
          <div
            className="flex flex-col items-start justify-center gap-0.5 md:min-h-[6.25rem]"
            role="group"
            aria-label="Selected checklist item"
          >
            <span className="text-passive-1 max-w-40 truncate text-xs" title={row.text}>
              {row.text}
            </span>
            <div className="flex items-center gap-0.5">
              <ToolbarButton
                name={`Complete ${row.text}`}
                aria-label={`Complete ${row.text}`}
                active={row.checked}
                disabled={!editable || (row.perPerson && !selfUuid)}
                onSelect={() => change(row.key, { checked: !row.checked })}
                aria-pressed={row.checked}
              >
                <Icon type="list-check" size="small" />
                <span className="ml-1.5 text-xs">Completed</span>
              </ToolbarButton>
              <ToolbarButton
                name={row.pinned ? 'Unpin item' : 'Pin item'}
                aria-label={row.pinned ? 'Unpin item' : 'Pin item'}
                iconName="pin-filled"
                active={row.pinned}
                aria-pressed={row.pinned}
                disabled={!editable}
                onSelect={() => change(row.key, { pinned: !row.pinned })}
              />
              <ToolbarButton
                name="Item comments"
                aria-label="Item comments"
                iconName="comment"
                disabled={!row.todoId && !editable}
                onSelect={() => showComments(row)}
              />
            </div>
            <div className="flex items-center gap-1">
              <Dropdown
                portal
                label={`Completion mode for ${row.text}`}
                value={row.perPerson ? 'personal' : 'shared'}
                disabled={!editable}
                onChange={(value) => change(row.key, { perPerson: value === 'personal' })}
                items={[
                  { value: 'shared', label: 'Single tick' },
                  { value: 'personal', label: 'Per person (multi-tick)' },
                ]}
                classNameOverride={dropdownStyle}
                popoverPlacement="bottom-start"
              />
              <Dropdown
                portal
                label={`Priority for ${row.text}`}
                value={row.priority}
                disabled={!editable}
                onChange={(value) => change(row.key, { priority: value as ChecklistPriority })}
                items={[
                  { value: 'high', label: '⚑ High' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'low', label: '⚑ Low' },
                ]}
                classNameOverride={dropdownStyle}
                popoverPlacement="bottom-start"
              />
            </div>
            {row.perPerson && (
              <span
                className="text-passive-1 max-w-48 truncate text-xs"
                title={row.ticks.map(tickName).join(', ')}
                aria-label={`Ticks for ${row.text}`}
              >
                {row.ticks.length ? `Ticked by ${row.ticks.map(tickName).join(', ')}` : 'No one has ticked this yet'}
              </span>
            )}
          </div>
        ) : (
          <p className="text-passive-1 text-xs">Place the cursor in a checklist item to change its settings.</p>
        )}
        <span
          aria-hidden
          className="text-passive-1 mt-px hidden truncate text-center text-[10px] leading-none font-medium tracking-wide uppercase select-none md:block"
        >
          Item settings
        </span>
      </section>
      <section
        hidden={activeSection !== 'checklist'}
        aria-label="Checklist organization"
        className="super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-1 py-0.5 text-sm"
      >
        <div className="flex flex-1 items-center justify-center md:min-h-[6.25rem]">
          <ChecklistOrganizeMenu flushChanges={flushChanges} />
        </div>
        <span aria-hidden className="text-passive-1 hidden text-center text-[10px] font-medium uppercase md:block">
          Organize
        </span>
      </section>
    </>
  )
}
