/**
 * The table layout policy against every export surface.
 *
 * This file exists because the failure mode for this feature is a policy the
 * screen respects and the exports silently ignore. Each claim in the honoured /
 * not-honoured matrix is pinned here, INCLUDING the two deliberate "not
 * honoured" ones:
 *
 *   - Markdown has no column-width or header-shading syntax at all, so a table
 *     exports with its `|---|` header divider and nothing else. Asserted, so that
 *     nothing later pretends otherwise.
 *   - Printing and standalone HTML deliberately fit the table to the page, which
 *     overrides the `content` (fit-content) method. That is the pre-existing
 *     paper-fit contract pinned by WidgetLayoutContract.spec.ts, not a gap this
 *     feature introduced.
 *
 * It also covers a pre-existing data-fidelity bug this work fixes: before the
 * DocModel table block carried header information, a table whose first row was a
 * header exported to DOCX and ODT as a table with NO header row — silently.
 */
import { installExportTestEnv } from './testEnvPolyfill'

installExportTestEnv()

import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createTextNode, $createParagraphNode, LexicalEditor } from 'lexical'
import { $createTableNodeWithDimensions, $isTableNode, TableNode } from '@lexical/table'
import BlocksEditorTheme from '../../Theme/Theme'
import { SuperExportNodes } from '../../Nodes/AllNodes'
import {
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  makeColumnWidthPolicy,
  TableWidthMethod,
} from '../../Nodes/TableLayoutPolicy'
import { MarkdownTransformers } from '../../../MarkdownTransformers'
import { $convertToMarkdownString } from '../MarkdownExport'
import { superStringToDocModel, DocBlock, DocTableLayout } from './DocModel'
import { buildDocxBlob } from './DocxGenerator'
import { buildOdtBlob } from './OdtGenerator'

const unzip = async (blob: Blob): Promise<Record<string, { text: () => Promise<string> }>> => {
  const zip = await import('@zip.js/zip.js')
  const { ZipReader, BlobReader, TextWriter } = zip
  const reader = new ZipReader(new BlobReader(blob))
  const entries = await reader.getEntries()
  const out: Record<string, { text: () => Promise<string> }> = {}
  for (const entry of entries) {
    const e = entry as unknown as { filename: string; getData?: (w: unknown) => Promise<string> }
    out[e.filename] = { text: async () => (e.getData ? e.getData(new TextWriter()) : '') }
  }
  await reader.close()
  return out
}

const assertWellFormedXml = (xml: string): void => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
}

type Policy = {
  method?: TableWidthMethod
  differentiated?: boolean
  columns?: Record<number, Parameters<typeof makeColumnWidthPolicy>>
}

/**
 * A 2x3 table whose first row IS a header row, carrying the given policy, as a
 * Super note string — the same bytes a real note would hold.
 */
const buildTableSuperString = (policy: Policy = {}): string => {
  const editor: LexicalEditor = createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => {
      throw error
    },
    nodes: SuperExportNodes,
  })
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const table = $createTableNodeWithDimensions(2, 3, true)
      root.append(table)
      let cellCounter = 0
      for (const row of table.getChildren()) {
        for (const cell of (
          row as unknown as { getChildren: () => { clear: () => { append: (n: unknown) => void } }[] }
        ).getChildren()) {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(`Cell${++cellCounter}`))
          // Replace the empty paragraph Lexical seeds the cell with rather than
          // appending beside it, so each cell holds exactly one paragraph the way a
          // real authored table does.
          cell.clear().append(paragraph)
        }
      }
      if (policy.method !== undefined) {
        $setTableWidthMethod(table, policy.method)
      }
      if (policy.differentiated !== undefined) {
        $setTableHeadersDifferentiated(table, policy.differentiated)
      }
      for (const [index, args] of Object.entries(policy.columns ?? {})) {
        $setTableColumnWidthPolicy(table, Number(index), makeColumnWidthPolicy(...args))
      }
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState())
}

const tableBlock = (blocks: DocBlock[]): Extract<DocBlock, { kind: 'table' }> => {
  const found = blocks.find((block) => block.kind === 'table')
  if (found === undefined || found.kind !== 'table') {
    throw new Error('no table block in the model')
  }
  return found
}

const layoutOf = async (policy: Policy = {}): Promise<DocTableLayout> => {
  const blocks = await superStringToDocModel(buildTableSuperString(policy))
  const layout = tableBlock(blocks).layout
  if (layout === undefined) {
    throw new Error('table block carries no layout')
  }
  return layout
}

/* ----------------------------------------------------- the shared doc model */

describe('the DocModel table block carries structure and layout', () => {
  it('reports the header row and header column that used to be dropped entirely', async () => {
    const layout = await layoutOf()
    // Lexical's own `$createTableNodeWithDimensions(..., includeHeaders)` marks the
    // first row AND the first column, so both counts are 1 for this fixture.
    expect(layout.headerRowCount).toBe(1)
    expect(layout.headerColumnCount).toBe(1)
  })

  it('reports header differentiation separately from header structure', async () => {
    const differentiated = await layoutOf({ differentiated: false })
    // Turning the styling off must not turn the header row into a body row.
    expect(differentiated.differentiatedHeaders).toBe(false)
    expect(differentiated.headerRowCount).toBe(1)
  })

  it('carries the width method and per-column widths', async () => {
    const layout = await layoutOf({
      method: 'fixed',
      columns: { 0: ['fixed', 150], 2: ['percent', 30] },
    })
    expect(layout.widthMethod).toBe('fixed')
    expect(layout.columnWidths).toEqual([{ kind: 'px', value: 150 }, null, { kind: 'percent', value: 30 }])
  })

  it('emits no column widths while the equal method suspends them', async () => {
    const layout = await layoutOf({ method: 'equal', columns: { 0: ['fixed', 150] } })
    expect(layout.columnWidths).toEqual([null, null, null])
  })
})

/* ------------------------------------------------------------------- DOCX */

describe('DOCX export honours the policy', () => {
  const documentXmlFor = async (policy: Policy = {}): Promise<string> => {
    const blocks = await superStringToDocModel(buildTableSuperString(policy))
    const files = await unzip(await buildDocxBlob(blocks))
    const xml = await files['word/document.xml'].text()
    assertWellFormedXml(xml)
    return xml
  }

  it('marks the header row as a repeating header row', async () => {
    expect(await documentXmlFor()).toContain('<w:tblHeader')
  })

  it('keeps the header row marked even with differentiation turned off', async () => {
    const xml = await documentXmlFor({ differentiated: false })
    expect(xml).toContain('<w:tblHeader')
    // ...but drops the shading that made it look different.
    expect(xml).not.toContain('F4F5F7')
  })

  it('shades header cells when headers are differentiated', async () => {
    expect(await documentXmlFor()).toContain('F4F5F7')
  })

  it('emits a fixed layout and the per-column widths for the fixed method', async () => {
    const xml = await documentXmlFor({ method: 'fixed', columns: { 1: ['fixed', 100] } })
    expect(xml).toContain('w:type="fixed"')
    // 100px -> 1500 dxa (1px = 0.75pt = 15 twentieths of a point).
    expect(xml).toContain('w:w="1500"')
    expect(xml).toContain('w:type="dxa"')
  })

  it('emits a percentage column width as an OOXML pct width', async () => {
    const xml = await documentXmlFor({ method: 'fixed', columns: { 0: ['percent', 40] } })
    // docx serializes a PERCENTAGE size with its unit.
    expect(xml).toContain('<w:tcW w:type="pct" w:w="40%"/>')
  })

  it('lets the content method shrink-wrap instead of filling the measure', async () => {
    const xml = await documentXmlFor({ method: 'content' })
    expect(xml).toContain('w:type="auto"')
  })
})

/* -------------------------------------------------------------------- ODT */

describe('ODT export honours the policy', () => {
  const contentXmlFor = async (policy: Policy = {}): Promise<string> => {
    const blocks = await superStringToDocModel(buildTableSuperString(policy))
    const files = await unzip(await buildOdtBlob(blocks))
    const xml = await files['content.xml'].text()
    assertWellFormedXml(xml)
    return xml
  }

  it('wraps the header row in table-header-rows, which it never used to', async () => {
    const xml = await contentXmlFor()
    expect(xml).toContain('<table:table-header-rows>')
    // One header row and one body row, in that order.
    expect(xml.indexOf('<table:table-header-rows>')).toBeLessThan(xml.lastIndexOf('<table:table-row>'))
  })

  it('keeps the header-rows structure with differentiation turned off', async () => {
    const xml = await contentXmlFor({ differentiated: false })
    expect(xml).toContain('<table:table-header-rows>')
    expect(xml).not.toContain('TblHdrCell')
  })

  it('shades header cells when headers are differentiated', async () => {
    const xml = await contentXmlFor()
    expect(xml).toContain('TblHdrCell')
    expect(xml).toContain('fo:background-color="#f4f5f7"')
  })

  it('emits an absolute column width in cm for a px policy', async () => {
    const xml = await contentXmlFor({ method: 'fixed', columns: { 0: ['fixed', 96] } })
    // 96px at 96dpi is exactly one inch, i.e. 2.54cm.
    expect(xml).toContain('style:column-width="2.540cm"')
  })

  it('emits a relative column width for a percentage policy', async () => {
    const xml = await contentXmlFor({ method: 'fixed', columns: { 1: ['percent', 35] } })
    expect(xml).toContain('style:rel-column-width="35*"')
  })

  it('falls back to the repeated no-width column form when every column is automatic', async () => {
    const xml = await contentXmlFor()
    expect(xml).toContain('table:number-columns-repeated="3"')
  })
})

/* ------------------------------------------------------- deliberate gaps */

describe('surfaces that cannot express the policy say nothing about it', () => {
  const markdownFor = (policy: Policy): string => {
    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (error: Error) => {
        throw error
      },
      nodes: SuperExportNodes,
    })
    editor.setEditorState(editor.parseEditorState(buildTableSuperString(policy)))
    let markdown = ''
    editor.update(
      () => {
        markdown = $convertToMarkdownString(MarkdownTransformers)
      },
      { discrete: true },
    )
    return markdown
  }

  it('expresses the header row in Markdown but has no syntax for widths at all', () => {
    const plain = markdownFor({})
    // Pin the content independently FIRST. The invariance assertion below compares
    // two outputs of the thing under test, so on its own it would also pass if the
    // exporter returned nothing at all for both.
    const squashed = plain.replace(/\s+/g, ' ')
    expect(squashed).toContain('| Cell1 | Cell2 | Cell3 |')
    expect(squashed).toContain('| Cell4 | Cell5 | Cell6 |')
    // The header divider is Markdown's entire vocabulary for "this row is a header".
    expect(plain).toMatch(/\|\s*---/)
    // A width policy and a plain-header flag change nothing, because Markdown
    // cannot say either — and so nothing in the output pretends they applied.
    expect(markdownFor({ method: 'fixed', columns: { 0: ['fixed', 150] }, differentiated: false })).toBe(plain)
  })

  it('leaves no width or shading trace in the DOCX for an all-automatic table', async () => {
    const blocks = await superStringToDocModel(buildTableSuperString({ method: 'content' }))
    const files = await unzip(await buildDocxBlob(blocks))
    const xml = await files['word/document.xml'].text()
    // No column width is asserted anywhere, because none was set.
    expect(xml).not.toContain('w:type="dxa"')
    expect(xml).not.toContain('w:type="pct"')
  })

  it('still identifies the header row for a table with no policy at all', async () => {
    // An existing note, untouched by this feature, must gain the header fidelity
    // without having opted into anything.
    const layout = await layoutOf()
    expect(layout.widthMethod).toBe('content')
    expect(layout.differentiatedHeaders).toBe(true)
    expect(layout.headerRowCount).toBe(1)
  })
})

/* ------------------------------------------------- header semantics survive */

describe('turning differentiation off never removes header semantics', () => {
  it('leaves the th cells and their Lexical header state alone', () => {
    const superString = buildTableSuperString({ differentiated: false })
    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (error: Error) => {
        throw error
      },
      nodes: SuperExportNodes,
    })
    editor.setEditorState(editor.parseEditorState(superString))
    let headerStates: number[] = []
    editor.getEditorState().read(() => {
      const table = $getRoot().getChildren().find($isTableNode) as TableNode
      headerStates = table
        .getChildren()
        .flatMap((row) => (row as unknown as { getChildren: () => { getHeaderStyles: () => number }[] }).getChildren())
        .map((cell) => cell.getHeaderStyles())
    })
    // The first row's three cells are still header cells.
    expect(headerStates.slice(0, 3).every((state) => state !== 0)).toBe(true)
  })
})
