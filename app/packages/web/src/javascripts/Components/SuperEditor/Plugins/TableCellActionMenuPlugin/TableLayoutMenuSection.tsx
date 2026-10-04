/**
 * Standard Red Notes — the Layout group of the table's selection-scoped controls.
 *
 * Lives in its own file deliberately: the table action menu's container
 * (positioning, portal, scroll/resize handling) is the pattern other widgets copy,
 * so this is ADDED to the menu body rather than reshaping anything around it.
 *
 * Every control here writes node state via `Lexical/Nodes/TableLayoutPolicy.ts`, so
 * the setting persists with the note and syncs. Nothing here closes the menu —
 * these are settings you try, not actions you fire once.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LexicalEditor } from 'lexical'
import {
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableColumnIndexFromTableCellNode,
  TableCellNode,
} from '@lexical/table'
import MenuSection from '@/Components/Menu/MenuSection'
import MenuRadioButtonItem from '@/Components/Menu/MenuRadioButtonItem'
import MenuSwitchButtonItem from '@/Components/Menu/MenuSwitchButtonItem'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import {
  $getTableColumnCount,
  $getTableColumnWidthPolicy,
  $getTableHeaderSetting,
  $getTableWidthSetting,
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  columnWidthHonouring,
  makeColumnWidthPolicy,
  MAX_COLUMN_WIDTH_PERCENT,
  MAX_COLUMN_WIDTH_PX,
  MIN_COLUMN_WIDTH_PERCENT,
  MIN_COLUMN_WIDTH_PX,
  TABLE_COLUMN_WIDTH_MODE_LABELS,
  TABLE_COLUMN_WIDTH_MODES,
  TABLE_WIDTH_METHOD_LABELS,
  TABLE_WIDTH_METHODS,
  TableColumnWidthMode,
  TableColumnWidthPolicy,
  TableWidthMethod,
} from '../../Lexical/Nodes/TableLayoutPolicy'

/**
 * What each width method actually does, in the tooltip beside it. These are
 * measured descriptions, not intentions: `fixed` does NOT also fill the width
 * when every column is sized (the table is then exactly as wide as the columns),
 * and a percentage under `content` has no definite width to resolve against, so
 * it is not applied at all.
 */
const WIDTH_METHOD_INFO: Record<TableWidthMethod, string> = {
  content:
    'The table is only as wide as its content needs, up to a readable maximum. A fixed column width acts as a minimum; a percentage has nothing to measure against here.',
  full: 'The table fills the width of the note. Column widths act as a minimum.',
  fixed:
    'Your column widths are used exactly. Size every column and the table is exactly as wide as they are; leave a column automatic and it takes the remaining width.',
  equal: 'Every column gets the same share of the width. Per-column widths are kept but not used.',
}

type LayoutReading = {
  method: TableWidthMethod
  methodUnrecognised: boolean
  differentiated: boolean
  headersUnrecognised: boolean
  columnIndex: number
  columnCount: number
  columnPolicy: TableColumnWidthPolicy
}

const MODE_BOUNDS: Record<Exclude<TableColumnWidthMode, 'auto'>, { min: number; max: number; unit: string }> = {
  fixed: { min: MIN_COLUMN_WIDTH_PX, max: MAX_COLUMN_WIDTH_PX, unit: 'px' },
  percent: { min: MIN_COLUMN_WIDTH_PERCENT, max: MAX_COLUMN_WIDTH_PERCENT, unit: '%' },
}

export function TableLayoutMenuSection({
  editor,
  tableCellNode,
}: {
  editor: LexicalEditor
  tableCellNode: TableCellNode
}): React.JSX.Element | null {
  const [reading, setReading] = useState<LayoutReading | null>(null)
  /** Draft text for the width number, so a half-typed value is not applied. */
  const [draft, setDraft] = useState('')

  const read = useCallback((): LayoutReading | null => {
    let result: LayoutReading | null = null
    editor.getEditorState().read(() => {
      if (!tableCellNode.isAttached()) {
        return
      }
      const table = $getTableNodeFromLexicalNodeOrThrow(tableCellNode)
      const columnIndex = $getTableColumnIndexFromTableCellNode(tableCellNode)
      const width = $getTableWidthSetting(table)
      const headers = $getTableHeaderSetting(table)
      result = {
        method: width.method,
        methodUnrecognised: width.unrecognised,
        differentiated: headers.differentiated,
        headersUnrecognised: headers.unrecognised,
        columnIndex,
        columnCount: $getTableColumnCount(table),
        columnPolicy: $getTableColumnWidthPolicy(table, columnIndex),
      }
    })
    return result
  }, [editor, tableCellNode])

  useEffect(() => {
    const next = read()
    setReading(next)
    setDraft(next?.columnPolicy.value !== undefined ? String(next.columnPolicy.value) : '')
  }, [read])

  const setMethod = useCallback(
    (method: TableWidthMethod) => {
      editor.update(() => {
        if (!tableCellNode.isAttached()) {
          return
        }
        $setTableWidthMethod($getTableNodeFromLexicalNodeOrThrow(tableCellNode), method)
      })
      setReading((current) => (current === null ? current : { ...current, method, methodUnrecognised: false }))
    },
    [editor, tableCellNode],
  )

  const setDifferentiated = useCallback(
    (differentiated: boolean) => {
      editor.update(() => {
        if (!tableCellNode.isAttached()) {
          return
        }
        $setTableHeadersDifferentiated($getTableNodeFromLexicalNodeOrThrow(tableCellNode), differentiated)
      })
      setReading((current) => {
        return current === null ? current : { ...current, differentiated, headersUnrecognised: false }
      })
    },
    [editor, tableCellNode],
  )

  const applyColumnPolicy = useCallback(
    (mode: TableColumnWidthMode, value?: number) => {
      const policy = makeColumnWidthPolicy(mode, value)
      editor.update(() => {
        if (!tableCellNode.isAttached()) {
          return
        }
        const table = $getTableNodeFromLexicalNodeOrThrow(tableCellNode)
        $setTableColumnWidthPolicy(table, $getTableColumnIndexFromTableCellNode(tableCellNode), policy)
      })
      setReading((current) => (current === null ? current : { ...current, columnPolicy: policy }))
      setDraft(policy.value !== undefined ? String(policy.value) : '')
    },
    [editor, tableCellNode],
  )

  const onModeSelected = useCallback(
    (mode: TableColumnWidthMode) => {
      if (mode === 'auto') {
        applyColumnPolicy('auto')
        return
      }
      // Seed a sized mode with the current number if there is one, otherwise with
      // a sane starting point for that unit rather than an empty width.
      const seeded = reading?.columnPolicy.value ?? (mode === 'fixed' ? 120 : 25)
      applyColumnPolicy(mode, seeded)
    },
    [applyColumnPolicy, reading],
  )

  const commitDraft = useCallback(() => {
    const mode = reading?.columnPolicy.mode
    if (mode === undefined || mode === 'auto') {
      return
    }
    const parsed = Number.parseFloat(draft)
    if (!Number.isFinite(parsed)) {
      // Nothing usable typed: put the applied value back rather than showing a
      // number the table is not using.
      setDraft(reading?.columnPolicy.value !== undefined ? String(reading.columnPolicy.value) : '')
      return
    }
    applyColumnPolicy(mode, parsed)
  }, [applyColumnPolicy, draft, reading])

  // Read the honouring through the SAME function the renderer resolves with, so
  // the notice below cannot drift from what the table actually does.
  const honouring = reading === null ? null : columnWidthHonouring(reading.method, reading.columnPolicy)
  const suspended = honouring === 'suspended'
  const ignored = honouring === 'ignored'
  const bounds = useMemo(
    () => (reading === null || reading.columnPolicy.mode === 'auto' ? null : MODE_BOUNDS[reading.columnPolicy.mode]),
    [reading],
  )

  if (reading === null) {
    return null
  }

  return (
    <>
      <MenuSection title="Table width">
        {TABLE_WIDTH_METHODS.map((method) => (
          <MenuRadioButtonItem
            key={method}
            checked={!reading.methodUnrecognised && reading.method === method}
            onClick={() => setMethod(method)}
            info={WIDTH_METHOD_INFO[method]}
          >
            {TABLE_WIDTH_METHOD_LABELS[method]}
          </MenuRadioButtonItem>
        ))}
        {reading.methodUnrecognised && (
          <div className="text-warning px-3 py-1 text-xs" role="status">
            This table has a saved width setting this version does not recognise. It is showing as “
            {TABLE_WIDTH_METHOD_LABELS[reading.method]}” until you choose one.
          </div>
        )}
      </MenuSection>

      <MenuSection title={`Column ${reading.columnIndex + 1} of ${reading.columnCount}`}>
        {TABLE_COLUMN_WIDTH_MODES.map((mode) => (
          <MenuRadioButtonItem
            key={mode}
            checked={!reading.columnPolicy.unrecognised && reading.columnPolicy.mode === mode}
            onClick={() => onModeSelected(mode)}
          >
            {TABLE_COLUMN_WIDTH_MODE_LABELS[mode]}
          </MenuRadioButtonItem>
        ))}
        {bounds !== null && (
          <label className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
            <span>Width ({bounds.unit})</span>
            <span className="w-24">
              <DecoratedInput
                type="number"
                value={draft}
                onChange={setDraft}
                onEnter={commitDraft}
                onBlur={commitDraft}
                title={`Between ${bounds.min} and ${bounds.max} ${bounds.unit}`}
              />
            </span>
          </label>
        )}
        {reading.columnPolicy.unrecognised && (
          <div className="text-warning px-3 py-1 text-xs" role="status">
            This column has a saved width this version does not recognise, so no width is being applied to it.
          </div>
        )}
        {reading.columnPolicy.clamped && (
          <div className="text-passive-1 px-3 py-1 text-xs" role="status">
            The saved width was outside the allowed range, so {reading.columnPolicy.value}
            {bounds?.unit ?? ''} is being used.
          </div>
        )}
        {suspended && (
          <div className="text-passive-1 px-3 py-1 text-xs" role="status">
            “Equal columns” is on, so per-column widths are kept but not applied.
          </div>
        )}
        {ignored && (
          <div className="text-passive-1 px-3 py-1 text-xs" role="status">
            “Fit content” sizes the table to its content, so a percentage has nothing to measure against and is not
            applied. Use a fixed width, or choose “Full width” or “Fixed columns”.
          </div>
        )}
      </MenuSection>

      <MenuSection title="Headers">
        <MenuSwitchButtonItem checked={reading.differentiated} onChange={setDifferentiated}>
          Differentiated headers
        </MenuSwitchButtonItem>
        <div className="text-passive-1 px-3 py-1 text-xs">
          Turning this off changes the header’s appearance only. Header rows and columns stay headers, in exports and
          for screen readers.
        </div>
        {reading.headersUnrecognised && (
          <div className="text-warning px-3 py-1 text-xs" role="status">
            This table has a saved header setting this version does not recognise, so headers are shown as
            differentiated.
          </div>
        )}
      </MenuSection>
    </>
  )
}
