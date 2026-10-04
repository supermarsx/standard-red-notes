import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.resolve(__dirname, '../../../../../..')
const read = (relativePath: string) => fs.readFileSync(path.join(webRoot, relativePath), 'utf8')

const editorScss = read('src/javascripts/Components/SuperEditor/Lexical/Theme/editor.scss')
const exportScss = read('src/javascripts/Components/SuperEditor/Lexical/Theme/export-overrides.scss')
const blocksEditor = read('src/javascripts/Components/SuperEditor/BlocksEditor.tsx')
const theme = read('src/javascripts/Components/SuperEditor/Lexical/Theme/Theme.ts')

describe('Super widget layout contract', () => {
  it('defines only the five explicit responsive layout categories', () => {
    for (const layout of ['compact', 'content', 'data', 'canvas', 'media']) {
      expect(editorScss).toContain(`[data-super-widget-layout='${layout}']`)
    }

    expect(editorScss).toMatch(/\[data-super-widget-layout\]\s*\{[^}]*max-inline-size:\s*100%/s)
    expect(editorScss).toMatch(
      /\[data-super-widget-layout='compact'\]\s*\{[^}]*inline-size:\s*fit-content[^}]*min\(100%, 42rem\)/s,
    )
    expect(editorScss).toMatch(
      /\[data-super-widget-layout='data'\]\s*\{[^}]*inline-size:\s*fit-content[^}]*max-inline-size:\s*min\(100%, 64rem\)/s,
    )
    expect(editorScss).not.toMatch(/\[data-super-widget-layout='data'\]\s*\{\s*inline-size:\s*min\(100%,\s*64rem\)/s)
    expect(editorScss).toMatch(/\[data-super-widget-layout='media'\]\s*\{[^}]*min\(100%, 64rem\)/s)
  })

  it.each([
    ['Lexical/Nodes/ClockNode.tsx', 'compact'],
    ['Lexical/Nodes/ShipmentTrackingNode.tsx', 'compact'],
    ['Lexical/Nodes/TableOfContentsNode.tsx', 'compact'],
    ['Lexical/Nodes/TweetEmbedNode.tsx', 'compact'],
    ['Lexical/Nodes/CalloutNode.tsx', 'content'],
    ['Lexical/Nodes/CommentNode.tsx', 'content'],
    ['Lexical/Nodes/QrCodeNode.tsx', 'content'],
    ['Lexical/Nodes/MathNode.tsx', 'content'],
    ['Lexical/Nodes/DataTableNode.tsx', 'data'],
    ['Lexical/Nodes/CalendarNode.tsx', 'data'],
    ['Lexical/Nodes/KanbanNode.tsx', 'data'],
    ['Lexical/Nodes/TimelineNode.tsx', 'data'],
    ['Lexical/Nodes/SqlQueryNode.tsx', 'data'],
    ['Lexical/Nodes/MermaidNode.tsx', 'canvas'],
    ['Lexical/Nodes/GanttChartNode.tsx', 'canvas'],
    ['Lexical/Nodes/TimingDiagramNode.tsx', 'canvas'],
    ['Lexical/Nodes/MusicStaffNode.tsx', 'canvas'],
    ['Lexical/Nodes/ExcalidrawComponent.tsx', 'canvas'],
    ['Lexical/Nodes/EmbedNode.tsx', 'media'],
    ['Lexical/Nodes/WebEmbedNode.tsx', 'media'],
    ['Lexical/Nodes/StockChartNode.tsx', 'media'],
    ['Lexical/Nodes/TradingViewNode.tsx', 'media'],
    ['Lexical/Nodes/YouTubeNode.tsx', 'media'],
  ])('tags %s as %s', (relativePath, layout) => {
    const source = read(`src/javascripts/Components/SuperEditor/${relativePath}`)
    expect(source).toContain(`data-super-widget-layout="${layout}"`)
  })

  it('uses Lexical local table scrolling with natural table width and visible portaled menus', () => {
    const tablePlugin = read('src/javascripts/Components/SuperEditor/Plugins/TablePlugin.tsx')
    const tableMenu = read('src/javascripts/Components/SuperEditor/Plugins/TableCellActionMenuPlugin/index.tsx')
    const dataTable = read('src/javascripts/Components/SuperEditor/Lexical/Nodes/DataTableNode.tsx')
    const sql = read('src/javascripts/Components/SuperEditor/Lexical/Nodes/SqlQueryNode.tsx')

    expect(blocksEditor).toContain('<TablePlugin hasCellMerge hasHorizontalScroll />')
    expect(blocksEditor).toContain('<TableWidgetLayoutPlugin />')
    expect(theme).toContain("tableScrollableWrapper: 'Lexical__tableScrollableWrapper'")
    expect(tablePlugin).toContain("setAttribute(SUPER_WIDGET_LAYOUT_ATTRIBUTE, 'data')")
    expect(editorScss).toMatch(
      /\.Lexical__tableScrollableWrapper\s*\{[^}]*inline-size:\s*fit-content[^}]*max-inline-size:\s*min\(100%, 64rem\)[^}]*overflow-x:\s*auto/s,
    )
    expect(editorScss).toMatch(/\.Lexical__table\s*\{[^}]*inline-size:\s*max-content/s)
    expect(editorScss).toMatch(/\.Lexical__table\s*\{[^}]*table-layout:\s*auto/s)
    // The 64rem default measure is a cap on the CONTENT-fit default only. The
    // three explicit width methods are the user stating the table's width, so
    // they fill the content column: measured in headless Chrome, `full` in a
    // 1200px column rendered 1024 before this and 1200 after it.
    expect(editorScss).toMatch(
      /\.Lexical__tableScrollableWrapper\[data-super-table-width='equal'\]\s*\{[^}]*inline-size:\s*100%[^}]*max-inline-size:\s*100%/s,
    )
    // ...and a `fixed` table whose every column is sized in px takes exactly the
    // width the resolver measured for it, instead of stretching those columns to
    // fill the measure (200/200/200 in a 700px column rendered 233/233/233).
    expect(editorScss).toMatch(
      /\[data-super-table-fit='columns'\]\s*\{[^}]*inline-size:\s*var\(--super-table-fit-width,\s*max-content\)[^}]*max-inline-size:\s*none/s,
    )
    // The attribute and the custom property are a contract between the resolver
    // and the stylesheet above: renaming either on one side only would silently
    // stop the fit from applying, with every unit test still green.
    const tableLayoutPolicy = read('src/javascripts/Components/SuperEditor/Lexical/Nodes/TableLayoutPolicy.ts')
    expect(tableLayoutPolicy).toContain("TABLE_FIT_ATTRIBUTE = 'data-super-table-fit'")
    expect(tableLayoutPolicy).toContain("TABLE_FIT_WIDTH_PROPERTY = '--super-table-fit-width'")
    expect(editorScss).not.toContain('width: calc(100% - 25px)')
    expect(dataTable).not.toContain('<table className="w-full')
    expect(sql).not.toContain('<table className="w-full')
    expect(tableMenu).toContain('createPortal(')
  })

  it('caps embedded media while leaving user-sized image renderers unclassified', () => {
    const superImage = read('src/javascripts/Components/SuperEditor/Plugins/ImageTools/SuperEmbeddedImage.tsx')
    const fileImage = read('src/javascripts/Components/FilePreview/ImagePreview.tsx')
    const preview = read('src/javascripts/Components/FilePreview/PreviewComponent.tsx')
    const audio = read('src/javascripts/Components/FilePreview/AudioPreview.tsx')
    const video = read('src/javascripts/Components/FilePreview/VideoPreview.tsx')

    expect(preview).toContain('data-super-widget-layout="media"')
    expect(audio).toContain('data-super-widget-layout="compact"')
    expect(video).toContain('data-super-widget-layout="media"')
    expect(editorScss).toMatch(/video\[data-super-widget-layout='media'\][^{]*\{[^}]*max-block-size:/s)
    expect(superImage).not.toContain('data-super-widget-layout')
    expect(fileImage).not.toContain('data-super-widget-layout')
  })

  it('fits tables to standalone HTML and printed paper', () => {
    expect(editorScss).toMatch(
      /@media print[\s\S]*\.Lexical__tableScrollableWrapper[\s\S]*overflow:\s*visible !important/,
    )
    expect(editorScss).toMatch(/@media print[\s\S]*\.Lexical__table[^{]*\{[^}]*table-layout:\s*fixed !important/s)
    expect(exportScss).toMatch(
      /\.Lexical__table[^{]*\{[^}]*inline-size:\s*100%[^}]*max-inline-size:\s*100%[^}]*table-layout:\s*fixed/s,
    )
    expect(exportScss).toMatch(/\.Lexical__tableCell,[\s\S]*overflow-wrap:\s*anywhere/)
    expect(exportScss).toMatch(
      /@media print[\s\S]*\.Lexical__tableScrollableWrapper[\s\S]*overflow:\s*visible !important/,
    )
    // PAPER OVERRIDES THE COLUMN FIT. editor.scss is part of the exported file's
    // <style> (NoteExportUtils.ts), and the fit rule's two attribute selectors
    // outrank export-overrides' bare `.Lexical__table` — measured in Chrome, the
    // exported table is 601px with 200/200/200 columns rather than filling a 900px
    // page. On paper it must still fill, and only `!important` can say so, since
    // no amount of specificity in the print block would outrank the fit rule.
    // Both anchors below are load-bearing, and both were put there by deleting the
    // `!important` and watching this assertion stay GREEN: `.Lexical__table[^{]*\{`
    // also matches `.Lexical__tableScrollableWrapper {`, whose own
    // `inline-size: 100% !important` satisfied it; and a bare `inline-size:` is a
    // substring of the `max-inline-size: 100% !important` two lines below it.
    expect(editorScss).toMatch(/@media print[\s\S]*\.Lexical__table\s*\{[^}]*(?<![-\w])inline-size:\s*100% !important/s)
  })
})
