import { NoteContent, classNames } from '@standardnotes/snjs'
import { CSSProperties, FunctionComponent, useMemo, useState } from 'react'
import {
  buildSplitRows,
  computeDiffStats,
  computeLineDiff,
  DiffLine,
  getDiffableTextFromContent,
} from './RevisionDiff'

type DiffViewMode = 'unified' | 'split'

type Props = {
  /** The older revision's content (rendered as the "removed"/left side). */
  oldContent: NoteContent
  /** The newer revision (or current note) content (the "added"/right side). */
  newContent: NoteContent
  oldLabel: string
  newLabel: string
}

/**
 * Theme-adaptive subtle backgrounds. We blend the semantic stylekit colors with
 * the editor background using color-mix so additions/removals read correctly in
 * both light and dark themes without hardcoding any color values.
 */
const ADDED_BACKGROUND: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--sn-stylekit-success-color) 16%, transparent)',
}
const REMOVED_BACKGROUND: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--sn-stylekit-danger-color) 16%, transparent)',
}

const lineBackgroundStyle = (type: DiffLine['type']): CSSProperties | undefined => {
  switch (type) {
    case 'added':
      return ADDED_BACKGROUND
    case 'removed':
      return REMOVED_BACKGROUND
    default:
      return undefined
  }
}

const lineTextColor = (type: DiffLine['type']): string => {
  switch (type) {
    case 'added':
      return 'text-success'
    case 'removed':
      return 'text-danger'
    default:
      return 'text-foreground'
  }
}

const lineSign = (type: DiffLine['type']): string => {
  switch (type) {
    case 'added':
      return '+'
    case 'removed':
      return '-'
    default:
      return ' '
  }
}

const SplitCell: FunctionComponent<{ line: DiffLine | null; side: 'old' | 'new' }> = ({ line, side }) => {
  if (!line) {
    return (
      <td className="border-r border-border bg-passive-5 align-top">
        <div>&nbsp;</div>
      </td>
    )
  }

  const number = side === 'old' ? line.oldNumber : line.newNumber

  return (
    <td className="border-r border-border align-top" style={lineBackgroundStyle(line.type)}>
      <div className="flex">
        <span className="inline-block w-10 flex-shrink-0 select-none border-r border-border px-2 text-right text-passive-1">
          {number ?? ''}
        </span>
        <span className={classNames('w-4 flex-shrink-0 select-none text-center', lineTextColor(line.type))}>
          {lineSign(line.type)}
        </span>
        <span className={classNames('whitespace-pre-wrap break-words px-1', lineTextColor(line.type))}>
          {line.text.length ? line.text : ' '}
        </span>
      </div>
    </td>
  )
}

const RevisionDiffView: FunctionComponent<Props> = ({ oldContent, newContent, oldLabel, newLabel }) => {
  const [viewMode, setViewMode] = useState<DiffViewMode>('split')

  const diffLines = useMemo(() => {
    const oldText = getDiffableTextFromContent(oldContent)
    const newText = getDiffableTextFromContent(newContent)
    return computeLineDiff(oldText, newText)
  }, [oldContent, newContent])

  const stats = useMemo(() => computeDiffStats(diffLines), [diffLines])
  const splitRows = useMemo(() => buildSplitRows(diffLines), [diffLines])

  const hasChanges = stats.added > 0 || stats.removed > 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-contrast px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold text-danger" title={oldLabel}>
            &minus; {oldLabel}
          </span>
          <span className="font-semibold text-success" title={newLabel}>
            + {newLabel}
          </span>
          <span className="text-passive-1">
            <span className="text-success">+{stats.added}</span>{' '}
            <span className="text-danger">&minus;{stats.removed}</span>
          </span>
        </div>
        <div className="flex items-center overflow-hidden rounded border border-border text-sm">
          <button
            className={classNames(
              'px-3 py-1 focus:shadow-none focus:outline-none',
              viewMode === 'split' ? 'bg-info text-info-contrast' : 'bg-default text-text hover:bg-contrast',
            )}
            onClick={() => setViewMode('split')}
          >
            Split
          </button>
          <button
            className={classNames(
              'border-l border-border px-3 py-1 focus:shadow-none focus:outline-none',
              viewMode === 'unified' ? 'bg-info text-info-contrast' : 'bg-default text-text hover:bg-contrast',
            )}
            onClick={() => setViewMode('unified')}
          >
            Unified
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-grow overflow-auto bg-default font-mono text-editor">
        {!hasChanges ? (
          <div className="select-none p-4 text-sm text-passive-0">No differences between these revisions.</div>
        ) : viewMode === 'unified' ? (
          <table className="w-full border-collapse">
            <tbody>
              {diffLines.map((line, index) => (
                <tr key={index} style={lineBackgroundStyle(line.type)}>
                  <td className="select-none border-r border-border px-2 text-right align-top text-passive-1">
                    {line.oldNumber ?? ''}
                  </td>
                  <td className="select-none border-r border-border px-2 text-right align-top text-passive-1">
                    {line.newNumber ?? ''}
                  </td>
                  <td className={classNames('w-4 select-none px-1 text-center align-top', lineTextColor(line.type))}>
                    {lineSign(line.type)}
                  </td>
                  <td className={classNames('whitespace-pre-wrap break-words px-2', lineTextColor(line.type))}>
                    {line.text.length ? line.text : ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full table-fixed border-collapse">
            <tbody>
              {splitRows.map((row, index) => (
                <tr key={index}>
                  <SplitCell line={row.left} side="old" />
                  <SplitCell line={row.right} side="new" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default RevisionDiffView
