import { useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getSelection, $isRangeSelection, $setSelection, BaseSelection } from 'lexical'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import Popover from '@/Components/Popover/Popover'
import ToolbarButton from '../Plugins/ToolbarPlugin/ToolbarButton'
import { $organizeCompletedTasks, ChecklistOrganizationAction } from './ChecklistTaskOrganization'

/** Explicit organization, without changing the automatic sorting preference. */
export function ChecklistOrganizeMenu({ flushChanges }: { flushChanges?: () => void }) {
  const [editor] = useLexicalComposerContext()
  const [open, setOpen] = useState(false)
  const [editable, setEditable] = useState(editor.isEditable())
  const anchor = useRef<HTMLButtonElement>(null)
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
    setOpen(false)
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
    <>
      <ToolbarButton
        ref={anchor}
        name="Organize completed tasks"
        aria-label="Organize completed tasks"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!editable}
        iconName="list-check"
        onSelect={() => setOpen(!open)}
      >
        <span className="ml-1.5 text-xs">Organize</span>
      </ToolbarButton>
      <Popover
        title="Organize completed tasks"
        anchorElement={anchor}
        open={open}
        togglePopover={() => setOpen(!open)}
        side="bottom"
        align="start"
        portal
        disableMobileFullscreenTakeover
        containerClassName="md:!min-w-64 md:!w-auto"
      >
        <Menu
          a11yLabel="Organize completed tasks"
          closeMenu={() => {
            setOpen(false)
            anchor.current?.focus()
          }}
          className="py-1"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MenuItem onClick={() => organize('selection')}>Sink completed within selection</MenuItem>
          <MenuItem onClick={() => organize('section')}>Sink completed within heading section</MenuItem>
          <MenuItem onClick={() => organize('completed-section')}>Move section’s completed to Completed tasks</MenuItem>
        </Menu>
      </Popover>
    </>
  )
}
