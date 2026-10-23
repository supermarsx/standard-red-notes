import { useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getSelection, $isRangeSelection, $setSelection, BaseSelection } from 'lexical'
import Icon from '@/Components/Icon/Icon'
import ToolbarButton from '../Plugins/ToolbarPlugin/ToolbarButton'
import { $organizeCompletedTasks, ChecklistOrganizationAction } from './ChecklistTaskOrganization'

/** Explicit organization, without changing the automatic sorting preference. */
export function ChecklistOrganizeMenu({ flushChanges }: { flushChanges?: () => void }) {
  const [editor] = useLexicalComposerContext()
  const [editable, setEditable] = useState(editor.isEditable())
  const selection = useRef<BaseSelection | null>(null)
  useEffect(() => {
    const refresh = () =>
      editor.getEditorState().read(() => {
        const current = $getSelection()
        if (current) {
          selection.current = current.clone()
        }
      })
    refresh()
    const stop = editor.registerUpdateListener(refresh)
    const stopEditable = editor.registerEditableListener(setEditable)
    return () => {
      stop()
      stopEditable()
    }
  }, [editor])
  const organize = (action: ChecklistOrganizationAction) => {
    if (!editor.isEditable()) {
      return
    }
    editor.update(
      () => {
        if (!editor.isEditable()) {
          return
        }
        const range = $getSelection() ?? selection.current
        if (!$isRangeSelection(range) || !$getNodeByKey(range.anchor.key) || !$getNodeByKey(range.focus.key)) {
          return
        }
        $setSelection(range.clone())
        $organizeCompletedTasks($getSelection(), action)
      },
      { onUpdate: flushChanges },
    )
  }
  return (
    <div className="flex flex-col items-start gap-0.5">
      {(
        [
          {
            action: 'selection',
            label: 'Selection',
            description: 'Sink completed within selection',
            icon: 'arrow-down',
          },
          {
            action: 'section',
            label: 'Section',
            description: 'Sink completed within heading section',
            icon: 'sort-descending',
          },
          {
            action: 'completed-section',
            label: 'Completed',
            description: 'Move section’s completed to Completed tasks',
            icon: 'list-check',
          },
        ] as const
      ).map(({ action, label, description, icon }) => (
        <ToolbarButton
          key={action}
          name={description}
          aria-label={description}
          disabled={!editable}
          onSelect={() => organize(action)}
        >
          <Icon type={icon} size="custom" className="super-toolbar-icon !text-current" />
          <span className="ml-1.5 text-xs whitespace-nowrap">{label}</span>
        </ToolbarButton>
      ))}
    </div>
  )
}
