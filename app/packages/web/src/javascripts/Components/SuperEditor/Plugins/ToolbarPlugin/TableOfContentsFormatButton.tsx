import { useCallback, useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getSelection, $nodesOfType, SKIP_DOM_SELECTION_TAG } from 'lexical'
import Popover from '@/Components/Popover/Popover'
import Icon from '@/Components/Icon/Icon'
import ToolbarButton from './ToolbarButton'
import {
  $isTableOfContentsNode,
  TableOfContentsNode,
  TableOfContentsFormat,
} from '../../Lexical/Nodes/TableOfContentsNode'

type Target = { key: string; format: TableOfContentsFormat }

/** Edits the persisted index block, rather than changing the navigation popover. */
export default function TableOfContentsFormatButton() {
  const [editor] = useLexicalComposerContext()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<Target[]>([])
  const [targetKey, setTargetKey] = useState('')
  const focusFirstControl = useCallback((element: HTMLDivElement | null) => {
    const control = element?.querySelector<HTMLElement>('select, input')
    control?.focus()
    // Popover measurement initially mounts its children under visibility:hidden.
    // Focus once the positioned content is visible, after its layout effects.
    if (control && document.activeElement !== control) {
      requestAnimationFrame(() => {
        if (control.isConnected) {
          control.focus()
        }
      })
    }
  }, [])
  useEffect(() => {
    const read = () =>
      editor.getEditorState().read(() => {
        const nodes = $nodesOfType(TableOfContentsNode)
        setTargets(nodes.map((node) => ({ key: node.getKey(), format: node.getFormat() })))
        // Once the menu opens, an explicit index choice takes precedence over
        // the editor selection retained behind the popover.
        const selected = open ? undefined : $getSelection()?.getNodes().find($isTableOfContentsNode)
        setTargetKey(
          (previous) =>
            selected?.getKey() ??
            (nodes.some((node) => node.getKey() === previous) ? previous : (nodes[0]?.getKey() ?? '')),
        )
      })
    read()
    return editor.registerUpdateListener(read)
  }, [editor, open])
  const target = targets.find(({ key }) => key === targetKey)
  const change = (format: Partial<TableOfContentsFormat>) =>
    editor.update(
      () => {
        if (!editor.isEditable()) {
          return
        }
        const node = $getNodeByKey(targetKey)
        if ($isTableOfContentsNode(node)) {
          node.setFormat(format)
        }
      },
      { tag: SKIP_DOM_SELECTION_TAG },
    )
  const fieldClass = 'border-border bg-default text-text rounded border px-2 py-1 text-sm'
  return (
    <>
      <ToolbarButton
        name="Format table of contents"
        disabled={!target}
        ref={anchor}
        active={open}
        onSelect={() => setOpen(!open)}
      >
        <Icon type="pencil-filled" size="small" />
        <span className="ml-1.5 text-sm">Format</span>
      </ToolbarButton>
      <Popover
        title="Format table of contents"
        anchorElement={anchor}
        open={open}
        togglePopover={() => setOpen(!open)}
        side="bottom"
        align="start"
        portal
        disableMobileFullscreenTakeover
      >
        <div
          ref={focusFirstControl}
          className="flex min-w-56 flex-col gap-3 p-3 text-sm"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Native form controls own their arrows/Space, not ribbon roving
            // focus. Escape also works when the popover is nested in a toolbar.
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              anchor.current?.focus()
            }
          }}
        >
          {!target ? (
            <p>Insert a table of contents first.</p>
          ) : (
            <>
              {targets.length > 1 && (
                <label className="flex flex-col gap-1">
                  Table of contents
                  <select
                    aria-label="Table of contents to format"
                    className={fieldClass}
                    value={targetKey}
                    onChange={(event) => setTargetKey(event.target.value)}
                  >
                    {targets.map(({ key }, index) => (
                      <option value={key} key={key}>
                        Table of contents {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                Heading depth
                <select
                  aria-label="Table of contents heading depth"
                  className={fieldClass}
                  value={target.format.maxLevel}
                  onChange={(event) => change({ maxLevel: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6].map((level) => (
                    <option key={level} value={level}>
                      Heading 1{level > 1 ? ` through ${level}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={target.format.numbered}
                  onChange={(event) => change({ numbered: event.target.checked })}
                />
                Number entries
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={target.format.showTitle}
                  onChange={(event) => change({ showTitle: event.target.checked })}
                />
                Show title
              </label>
              <p className="text-passive-1 text-xs">Entries update automatically when headings change.</p>
            </>
          )}
        </div>
      </Popover>
    </>
  )
}
