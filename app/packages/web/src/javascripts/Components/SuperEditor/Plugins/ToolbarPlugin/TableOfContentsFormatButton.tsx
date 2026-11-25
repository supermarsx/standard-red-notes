import { useCallback, useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, $getSelection, $nodesOfType, SKIP_DOM_SELECTION_TAG } from 'lexical'
import Popover from '@/Components/Popover/Popover'
import Icon from '@/Components/Icon/Icon'
import ToolbarButton from './ToolbarButton'
import {
  $isTableOfContentsNode,
  DEFAULT_TABLE_OF_CONTENTS_FORMAT,
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
  const fieldClass = 'border-border bg-default text-text min-w-0 w-full rounded border px-2 py-1 text-sm'
  const numberField = (
    key: 'titleSize' | 'subtitleSize' | 'entrySize' | 'indentation' | 'entrySpacing',
    label: string,
    min: number,
    max: number,
  ) =>
    target && (
      <label className="flex flex-col gap-1">
        {label}
        <input
          aria-label={`Table of contents ${label.toLowerCase()}`}
          type="number"
          min={min}
          max={max}
          className={fieldClass}
          value={target.format[key]}
          onChange={(event) => {
            if (event.target.value !== '') {
              change({ [key]: Number(event.target.value) })
            }
          }}
        />
      </label>
    )
  const selectField = (
    key: 'font' | 'alignment' | 'titleWeight' | 'appearance',
    label: string,
    options: [string, string][],
  ) =>
    target && (
      <label className="flex flex-col gap-1">
        {label}
        <select
          aria-label={`Table of contents ${label.toLowerCase()}`}
          className={fieldClass}
          value={target.format[key]}
          onChange={(event) => change({ [key]: event.target.value })}
        >
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
    )
  const colorField = (key: 'titleColor' | 'subtitleColor' | 'entryColor', label: string) =>
    target && (
      <label className="flex items-center justify-between gap-2">
        {label}
        <span className="flex items-center gap-2">
          <input
            aria-label={`Table of contents ${label.toLowerCase()}`}
            type="color"
            value={target.format[key] || '#808080'}
            onChange={(event) => change({ [key]: event.target.value })}
          />
          <button
            type="button"
            className="text-info text-xs underline"
            aria-label={`Use theme ${label.toLowerCase()}`}
            onClick={(event) => {
              event.preventDefault()
              change({ [key]: '' })
            }}
          >
            Use theme
          </button>
        </span>
      </label>
    )
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
          className="flex max-h-[75vh] w-80 max-w-[90vw] flex-col gap-3 overflow-y-auto p-3 text-sm"
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
                    {targets.map(({ key, format }, index) => (
                      <option value={key} key={key}>
                        {format.title.trim() || 'Table of contents'} ({index + 1})
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
              <label className="flex flex-col gap-1">
                Title
                <input
                  aria-label="Table of contents title"
                  className={fieldClass}
                  maxLength={256}
                  value={target.format.title}
                  onChange={(event) => change({ title: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                Subtitle <span className="text-passive-1 text-xs">Optional</span>
                <textarea
                  aria-label="Table of contents subtitle"
                  className={fieldClass}
                  rows={2}
                  maxLength={1000}
                  value={target.format.subtitle}
                  placeholder="Add a short description…"
                  onChange={(event) => change({ subtitle: event.target.value })}
                />
              </label>
              <details className="border-border border-t pt-2">
                <summary className="cursor-pointer font-semibold">Typography and colors</summary>
                <div className="mt-3 flex flex-col gap-3">
                  {selectField('font', 'Font', [
                    ['document', 'Document font'],
                    ['sans', 'Sans serif'],
                    ['serif', 'Serif'],
                    ['mono', 'Monospace'],
                  ])}
                  {selectField('alignment', 'Alignment', [
                    ['start', 'Start'],
                    ['center', 'Center'],
                    ['end', 'End'],
                  ])}
                  <div className="grid grid-cols-2 gap-3">
                    {numberField('titleSize', 'Title size', 8, 48)}
                    {numberField('subtitleSize', 'Subtitle size', 8, 32)}
                    {numberField('entrySize', 'Entry size', 8, 32)}
                    {selectField('titleWeight', 'Title weight', [
                      ['normal', 'Normal'],
                      ['semibold', 'Semibold'],
                      ['bold', 'Bold'],
                    ])}
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={target.format.titleItalic}
                      onChange={(event) => change({ titleItalic: event.target.checked })}
                    />
                    Italic title
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={target.format.uppercaseTitle}
                      onChange={(event) => change({ uppercaseTitle: event.target.checked })}
                    />
                    Uppercase title
                  </label>
                  {colorField('titleColor', 'Title color')}
                  {colorField('subtitleColor', 'Subtitle color')}
                  {colorField('entryColor', 'Entry color')}
                </div>
              </details>
              <details className="border-border border-t pt-2">
                <summary className="cursor-pointer font-semibold">Layout and spacing</summary>
                <div className="mt-3 flex flex-col gap-3">
                  {selectField('appearance', 'Appearance', [
                    ['card', 'Bordered card'],
                    ['plain', 'Plain text'],
                  ])}
                  {numberField('indentation', 'Nested heading indent', 0, 64)}
                  {numberField('entrySpacing', 'Entry spacing', 0, 24)}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={target.format.wrapEntries}
                      onChange={(event) => change({ wrapEntries: event.target.checked })}
                    />
                    Wrap long entries
                  </label>
                </div>
              </details>
              <button
                type="button"
                className="text-info self-start text-sm underline"
                onClick={() =>
                  change({
                    ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
                    title: target.format.title,
                    subtitle: target.format.subtitle,
                  })
                }
              >
                Reset formatting
              </button>
              <p className="text-passive-1 text-xs">Entries update automatically when headings change.</p>
            </>
          )}
        </div>
      </Popover>
    </>
  )
}
