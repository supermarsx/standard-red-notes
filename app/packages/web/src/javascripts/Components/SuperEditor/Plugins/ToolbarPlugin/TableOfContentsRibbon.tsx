import { ReactNode, useEffect, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import { $getNodeByKey } from 'lexical'
import { Toolbar, useToolbarStore } from '@ariakit/react'
import {
  $isTableOfContentsNode,
  DEFAULT_TABLE_OF_CONTENTS_FORMAT,
  TableOfContentsFormat,
} from '../../Lexical/Nodes/TableOfContentsNode'
import {
  $noteSectionTargets,
  $readTocHeadings,
  orderTocHeadings,
  TocHeading,
  tocSibling,
} from '../../Lexical/Utils/tableOfContentsOutline'
import { changeTableOfContents, moveContentsEntry, moveContentsNoteSection } from './tableOfContentsActions'

const inputClass = 'border-border bg-default text-text min-w-0 rounded border px-1.5 py-0.5 text-xs disabled:opacity-50'
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-2 py-1"
    >
      <div className="flex min-h-[6.25rem] flex-col justify-center gap-1">{children}</div>
      <span aria-hidden className="text-passive-1 mt-1 text-center text-[10px] font-medium uppercase">
        {label}
      </span>
    </div>
  )
}

/** Full contextual ribbon, bound to one explicit index even in a multi-index note. */
export default function TableOfContentsRibbon({ nodeKey }: { nodeKey: string }) {
  const [editor] = useLexicalComposerContext()
  const editable = useLexicalEditable()
  const store = useToolbarStore()
  const [snapshot, setSnapshot] = useState<{
    format: TableOfContentsFormat
    headings: TocHeading[]
    sectionMoves: Record<string, [boolean, boolean]>
  } | null>(null)
  const [headingKey, setHeadingKey] = useState('')
  useEffect(() => {
    let previous = ''
    const read = () =>
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey)
        if (!$isTableOfContentsNode(node)) {
          setSnapshot(null)
          return
        }
        const format = node.getFormat()
        const headings = orderTocHeadings($readTocHeadings(), format.entryOrder).filter(
          ({ level }) => level <= format.maxLevel,
        )
        const targets = $noteSectionTargets()
        const sectionMoves: Record<string, [boolean, boolean]> = Object.fromEntries(
          headings.map(({ key }) => [key, [Boolean(targets.get(key)?.[0]), Boolean(targets.get(key)?.[1])]]),
        )
        const next = { format, headings, sectionMoves }
        const signature = JSON.stringify(next)
        if (signature !== previous) {
          previous = signature
          setSnapshot(next)
          setHeadingKey((current) => (headings.some(({ key }) => key === current) ? current : (headings[0]?.key ?? '')))
        }
      })
    read()
    return editor.registerUpdateListener(read)
  }, [editor, nodeKey])
  if (!snapshot) {
    return null
  }
  const { format, headings, sectionMoves } = snapshot
  const selected = headings.find(({ key }) => key === headingKey) ?? headings[0]
  const change = (patch: Partial<TableOfContentsFormat>) => changeTableOfContents(editor, nodeKey, patch)
  const text = (key: 'title' | 'subtitle', label: string, maxLength: number) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      {key === 'subtitle' ? (
        <textarea
          rows={2}
          aria-label="Contents subtitle"
          className={`${inputClass} w-44`}
          value={format.subtitle}
          maxLength={maxLength}
          onChange={(event) => change({ subtitle: event.target.value })}
        />
      ) : (
        <input
          aria-label={`Contents ${label.toLowerCase()}`}
          className={`${inputClass} w-44`}
          value={format[key]}
          maxLength={maxLength}
          onChange={(event) => change({ [key]: event.target.value })}
        />
      )}
    </label>
  )
  const number = (
    key: 'titleSize' | 'subtitleSize' | 'entrySize' | 'indentation' | 'entrySpacing',
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      <input
        type="number"
        aria-label={`Contents ${label.toLowerCase()}`}
        className={`${inputClass} w-14`}
        min={min}
        max={max}
        value={format[key]}
        onChange={(event) => {
          if (event.target.value !== '') {
            change({ [key]: Number(event.target.value) })
          }
        }}
      />
    </label>
  )
  const select = (
    key: 'font' | 'alignment' | 'titleWeight' | 'appearance',
    label: string,
    values: [string, string][],
  ) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      <select
        aria-label={`Contents ${label.toLowerCase()}`}
        className={`${inputClass} max-w-32`}
        value={format[key]}
        onChange={(event) => change({ [key]: event.target.value })}
      >
        {values.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
  const check = (key: 'numbered' | 'showTitle' | 'titleItalic' | 'uppercaseTitle' | 'wrapEntries', label: string) => (
    <label className="flex items-center gap-1.5 text-xs">
      <input type="checkbox" checked={format[key]} onChange={(event) => change({ [key]: event.target.checked })} />
      {label}
    </label>
  )
  const buttonClass = `${inputClass} hover:bg-contrast disabled:cursor-not-allowed disabled:opacity-40`
  return (
    <Toolbar
      store={store}
      aria-label="Table of contents tools"
      data-toc-ribbon={nodeKey}
      className="super-toolbar flex flex-grow flex-wrap items-start gap-1.5 px-1 py-1"
      onKeyDownCapture={(event) => {
        if ((event.target as Element).closest('input, select, textarea')) {
          event.stopPropagation()
        }
      }}
    >
      <fieldset disabled={!editable} className="contents">
        <Group label="Contents text">
          {text('title', 'Title', 256)}
          {text('subtitle', 'Subtitle', 1000)}
          {check('showTitle', 'Show title')}
        </Group>
        <Group label="Title typography">
          {number('titleSize', 'Title size', 8, 48)}
          {number('subtitleSize', 'Subtitle size', 8, 32)}
          {select('titleWeight', 'Title weight', [
            ['normal', 'Normal'],
            ['semibold', 'Semibold'],
            ['bold', 'Bold'],
          ])}
          <div className="flex gap-2">
            {check('titleItalic', 'Italic')}
            {check('uppercaseTitle', 'Uppercase')}
          </div>
        </Group>
        <Group label="Contents entries">
          {select('font', 'Font', [
            ['document', 'Document'],
            ['sans', 'Sans serif'],
            ['serif', 'Serif'],
            ['mono', 'Monospace'],
          ])}
          <label className="flex items-center justify-between gap-2 text-xs">
            Heading depth
            <select
              aria-label="Contents heading depth"
              className={inputClass}
              value={format.maxLevel}
              onChange={(event) => change({ maxLevel: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  H1–H{level}
                </option>
              ))}
            </select>
          </label>
          {number('entrySize', 'Entry size', 8, 32)}
          <div className="flex gap-2">
            {check('numbered', 'Numbered')}
            {check('wrapEntries', 'Wrap entries')}
          </div>
        </Group>
        <Group label="Contents appearance">
          {select('alignment', 'Alignment', [
            ['start', 'Start'],
            ['center', 'Center'],
            ['end', 'End'],
          ])}
          {select('appearance', 'Appearance', [
            ['card', 'Bordered card'],
            ['plain', 'Plain text'],
          ])}
          {number('indentation', 'Nested indent', 0, 64)}
          {number('entrySpacing', 'Entry spacing', 0, 24)}
        </Group>
        <Group label="Contents colors">
          {(['titleColor', 'subtitleColor', 'entryColor'] as const).map((key, index) => (
            <label key={key} className="flex items-center justify-between gap-2 text-xs">
              {['Title', 'Subtitle', 'Entries'][index]}
              <input
                type="color"
                className="h-5 w-8 border-0 bg-transparent p-0"
                aria-label={`Contents ${['title', 'subtitle', 'entry'][index]} color`}
                value={format[key] || '#808080'}
                onChange={(event) => change({ [key]: event.target.value })}
              />
              <button
                type="button"
                className="text-info text-xs underline"
                aria-label={`Use theme ${['title', 'subtitle', 'entry'][index]} color`}
                onClick={() => change({ [key]: '' })}
              >
                Theme
              </button>
            </label>
          ))}
          <button
            type="button"
            className={buttonClass}
            onClick={() =>
              change({
                ...DEFAULT_TABLE_OF_CONTENTS_FORMAT,
                title: format.title,
                subtitle: format.subtitle,
                entryOrder: format.entryOrder,
              })
            }
          >
            Reset formatting
          </button>
        </Group>
      </fieldset>
      <Group label="Organize sections">
        <select
          aria-label="Contents section"
          className={`${inputClass} max-w-64`}
          value={selected?.key ?? ''}
          disabled={!headings.length}
          onChange={(event) => setHeadingKey(event.target.value)}
        >
          {!headings.length && <option value="">No headings found</option>}
          {headings.map(({ key, text, level }) => (
            <option key={key} value={key}>
              {'  '.repeat(level - 1)}
              {text}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-0.5 text-xs">
            <span>Contents order</span>
            <div className="flex gap-1">
              {([-1, 1] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  aria-label={`Move contents entry ${direction < 0 ? 'up' : 'down'}`}
                  title="Move this entry and its nested entries in this contents block."
                  className={`${buttonClass} w-8`}
                  disabled={!editable || !selected || !tocSibling(headings, selected.key, direction)}
                  onClick={() => selected && moveContentsEntry(editor, nodeKey, selected.key, direction)}
                >
                  {direction < 0 ? '↑' : '↓'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 text-xs">
            <span>Note section</span>
            <div className="flex gap-1">
              {([-1, 1] as const).map((direction, index) => (
                <button
                  key={direction}
                  type="button"
                  aria-label={`Move note section ${direction < 0 ? 'up' : 'down'}`}
                  title="Move this heading, its body, and nested subsections in the note."
                  className={`${buttonClass} w-8`}
                  disabled={!editable || !selected || !sectionMoves[selected.key]?.[index]}
                  onClick={() => selected && moveContentsNoteSection(editor, nodeKey, selected.key, direction)}
                >
                  {direction < 0 ? '↑' : '↓'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className={buttonClass}
            disabled={!editable || !format.entryOrder.length}
            onClick={() => change({ entryOrder: [] })}
          >
            Follow note order
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!selected}
            onClick={() => {
              if (selected) {
                editor.getElementByKey(selected.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            }}
          >
            Go to section
          </button>
        </div>
      </Group>
    </Toolbar>
  )
}
