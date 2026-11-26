import { useRef, useState } from 'react'
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  BaseSelection,
  HISTORY_PUSH_TAG,
  LexicalEditor,
} from 'lexical'
import Popover from '@/Components/Popover/Popover'
import ToolbarButton from './ToolbarButton'
import { INSERT_COLLAPSIBLE_COMMAND } from '../CollapsiblePlugin'

export default function InsertAccordionButton({ editor }: { editor: LexicalEditor }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const selection = useRef<BaseSelection | null>(null)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('Accordion section')
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState('')
  return (
    <>
      <ToolbarButton
        ref={anchor}
        name="Accordion zone"
        aria-label="Insert accordion zone"
        iconName="details-block"
        aria-haspopup="dialog"
        aria-expanded={open}
        onSelect={() => {
          selection.current = editor.getEditorState().read(() => $getSelection()?.clone() ?? null)
          setWrap($isRangeSelection(selection.current) && !selection.current.isCollapsed())
          setError('')
          setOpen(true)
        }}
      />
      <Popover
        title="Accordion zone"
        open={open}
        anchorElement={anchor}
        togglePopover={() => setOpen(false)}
        side="bottom"
        align="start"
        portal
        disableMobileFullscreenTakeover
      >
        <form
          className="bg-default text-text flex w-72 flex-col gap-3 p-3"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              anchor.current?.focus()
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (!editor.isEditable()) {
              return
            }
            editor.update(
              () => {
                const saved = selection.current
                if ($isRangeSelection(saved) && (!$getNodeByKey(saved.anchor.key) || !$getNodeByKey(saved.focus.key))) {
                  setError('The selection changed. Close this menu and select the blocks again.')
                  return
                }
                $setSelection(saved?.clone() ?? null)
                if (
                  editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, { title, open: expanded, wrapSelection: wrap })
                ) {
                  setOpen(false)
                  editor.focus()
                } else {
                  setError('Select blocks inside one section to create an accordion zone.')
                }
              },
              { tag: HISTORY_PUSH_TAG },
            )
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Zone title
            <input
              aria-label="Accordion zone title"
              className="border-border bg-default text-text rounded border px-2 py-1"
              value={title}
              maxLength={256}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
            Wrap selected blocks
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={expanded} onChange={(event) => setExpanded(event.target.checked)} />
            Initially expanded
          </label>
          {error && (
            <p role="alert" className="text-danger text-xs">
              {error}
            </p>
          )}
          <button className="bg-info text-info-contrast rounded px-3 py-1 text-sm" type="submit">
            Add accordion zone
          </button>
        </form>
      </Popover>
    </>
  )
}
