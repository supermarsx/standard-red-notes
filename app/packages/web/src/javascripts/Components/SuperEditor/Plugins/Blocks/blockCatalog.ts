/**
 * Standard Red Notes: single source of truth for every insertable Super-editor
 * block. Both the slash ("/") BlockPicker and the toolbar Insert menu derive
 * their list from this catalog so the two can never drift out of parity.
 *
 * Each `*Block` object under `Plugins/Blocks/*` already exposes a
 * `{ name, iconName, keywords, onSelect(editor) }` shape; this module re-exports
 * them as a flat, *categorized*, ordered list. A few blocks (Table, Image from
 * URL, Upload file) need a modal opener rather than a pure editor mutation, so
 * `onSelect` receives an optional `BlockCatalogContext` carrying those helpers.
 */
import { LexicalEditor } from 'lexical'

import { ParagraphBlock } from './Paragraph'
import { H1Block, H2Block, H3Block } from './Headings'
import { QuoteBlock } from './Quote'
import { CodeBlock } from './Code'
import { DividerBlock } from './Divider'
import { PageBreakBlock } from './PageBreak'
import { CalloutBlock } from './Callout'
import { CollapsibleBlock } from './Collapsible'
import { TableOfContentsBlock } from './TableOfContents'
import { BulletedListBlock, NumberedListBlock, ChecklistBlock } from './List'
import { GetDatetimeBlocks } from './DateTime'
import { PasswordBlock } from './Password'
import { BookmarkBlock } from './Bookmark'
import { FootnoteBlock } from './Footnote'
import { MathBlock } from './Math'
import { InlineMathBlock } from './InlineMath'
import { ClockBlock } from './Clock'
import { QrCodeBlock } from './QrCode'
import { KanbanBlock } from './Kanban'
import { CalendarBlock } from './Calendar'
import { TimelineBlock } from './Timeline'
import { DataviewBlock } from './Dataview'
import { SqlQueryBlock } from './SqlQuery'
import { MermaidBlock } from './Mermaid'
import { ExcalidrawBlock } from './Excalidraw'
import { GanttChartBlock } from './GanttChart'
import { TimingDiagramBlock } from './TimingDiagram'
import { MusicStaffBlock } from './MusicStaff'
import { TradingViewBlock } from './TradingView'
import { StockChartBlock } from './StockChart'
import { EmbedBlock } from './Embed'
import { WebEmbedBlock } from './WebEmbed'
import { TweetEmbedBlock } from './TweetEmbed'

/**
 * Modal/command helpers some catalog entries need (they open a dialog rather
 * than mutating the editor directly). Provided by the host (toolbar / picker).
 */
export type BlockCatalogContext = {
  openInsertTableDialog: () => void
  openInsertImageFromUrlDialog: () => void
  openFileUpload: () => void
}

/** Fixed, ordered set of categories the Insert menu groups blocks under. */
export const BLOCK_CATEGORIES = [
  'Basic',
  'Lists',
  'Media',
  'Data & tables',
  'Diagrams & charts',
  'Finance',
  'Embeds',
  'Advanced',
] as const

export type BlockCategory = (typeof BLOCK_CATEGORIES)[number]

export type BlockCatalogEntry = {
  /** Stable identity (used as React key / parity dedupe). */
  key: string
  name: string
  iconName: string
  keywords: string[]
  category: BlockCategory
  onSelect: (editor: LexicalEditor, ctx: BlockCatalogContext) => void
}

/** Adapt a `{ name, iconName, keywords, onSelect(editor) }` block object. */
const fromBlock = (
  block: { name: string; iconName: string; keywords: string[]; onSelect: (editor: LexicalEditor) => void },
  category: BlockCategory,
): BlockCatalogEntry => ({
  key: block.name,
  name: block.name,
  iconName: block.iconName,
  keywords: block.keywords,
  category,
  onSelect: (editor) => block.onSelect(editor),
})

/**
 * The full catalog. Order within a category IS the display order. The slash
 * picker concatenates these (preserving category order); the toolbar Insert
 * menu renders them grouped under their category headers.
 */
export const BLOCK_CATALOG: BlockCatalogEntry[] = [
  // ----- Basic -----------------------------------------------------------
  fromBlock(ParagraphBlock, 'Basic'),
  fromBlock(H1Block, 'Basic'),
  fromBlock(H2Block, 'Basic'),
  fromBlock(H3Block, 'Basic'),
  fromBlock(QuoteBlock, 'Basic'),
  fromBlock(CodeBlock, 'Basic'),
  fromBlock(CalloutBlock, 'Basic'),
  fromBlock(DividerBlock, 'Basic'),
  fromBlock(PageBreakBlock, 'Basic'),
  fromBlock(CollapsibleBlock, 'Basic'),

  // ----- Lists -----------------------------------------------------------
  fromBlock(BulletedListBlock, 'Lists'),
  fromBlock(NumberedListBlock, 'Lists'),
  fromBlock(ChecklistBlock, 'Lists'),

  // ----- Media -----------------------------------------------------------
  {
    key: 'ImageFromUrl',
    name: 'Image from URL',
    iconName: 'image',
    keywords: ['image', 'url', 'picture', 'photo'],
    category: 'Media',
    onSelect: (_editor, ctx) => ctx.openInsertImageFromUrlDialog(),
  },
  {
    key: 'UploadFile',
    name: 'Upload file',
    iconName: 'file',
    keywords: ['image', 'upload', 'file', 'attachment'],
    category: 'Media',
    onSelect: (_editor, ctx) => ctx.openFileUpload(),
  },
  fromBlock(ExcalidrawBlock, 'Media'),
  fromBlock(QrCodeBlock, 'Media'),

  // ----- Data & tables ---------------------------------------------------
  {
    key: 'Table',
    name: 'Table',
    iconName: 'table',
    keywords: ['table', 'grid', 'spreadsheet', 'rows', 'columns'],
    category: 'Data & tables',
    onSelect: (_editor, ctx) => ctx.openInsertTableDialog(),
  },
  fromBlock(KanbanBlock, 'Data & tables'),
  fromBlock(CalendarBlock, 'Data & tables'),
  fromBlock(TimelineBlock, 'Data & tables'),
  fromBlock(DataviewBlock, 'Data & tables'),
  fromBlock(SqlQueryBlock, 'Data & tables'),

  // ----- Diagrams & charts ----------------------------------------------
  fromBlock(MermaidBlock, 'Diagrams & charts'),
  fromBlock(GanttChartBlock, 'Diagrams & charts'),
  fromBlock(TimingDiagramBlock, 'Diagrams & charts'),
  fromBlock(MusicStaffBlock, 'Diagrams & charts'),

  // ----- Finance ---------------------------------------------------------
  fromBlock(TradingViewBlock, 'Finance'),
  fromBlock(StockChartBlock, 'Finance'),

  // ----- Embeds ----------------------------------------------------------
  fromBlock(EmbedBlock, 'Embeds'),
  fromBlock(WebEmbedBlock, 'Embeds'),
  fromBlock(TweetEmbedBlock, 'Embeds'),

  // ----- Advanced --------------------------------------------------------
  fromBlock(MathBlock, 'Advanced'),
  fromBlock(InlineMathBlock, 'Advanced'),
  fromBlock(FootnoteBlock, 'Advanced'),
  fromBlock(BookmarkBlock, 'Advanced'),
  fromBlock(TableOfContentsBlock, 'Advanced'),
  fromBlock(PasswordBlock, 'Advanced'),
  fromBlock(ClockBlock, 'Advanced'),
]

/**
 * Datetime entries are editor-bound (they dispatch a command with a captured
 * editor) so they can't be in the static catalog; this appends them under
 * "Advanced". Used to keep the Insert menu and slash picker in parity.
 */
export const getDatetimeCatalogEntries = (editor: LexicalEditor): BlockCatalogEntry[] =>
  GetDatetimeBlocks(editor).map((block) => ({
    key: `datetime:${block.name}`,
    name: block.name,
    iconName: block.iconName,
    keywords: block.keywords,
    category: 'Advanced' as BlockCategory,
    onSelect: () => block.onSelect(),
  }))

/** Full catalog (static entries + the editor-bound datetime entries). */
export const getFullBlockCatalog = (editor: LexicalEditor): BlockCatalogEntry[] => [
  ...BLOCK_CATALOG,
  ...getDatetimeCatalogEntries(editor),
]

/** Filter a catalog by a free-text query against name + keywords (case-insensitive). */
export const filterBlockCatalog = (entries: BlockCatalogEntry[], query: string): BlockCatalogEntry[] => {
  const q = query.trim().toLowerCase()
  if (!q) {
    return entries
  }
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(q) || entry.keywords.some((keyword) => keyword.toLowerCase().includes(q)),
  )
}

/** Group a (possibly already-filtered) catalog into category order, dropping empty categories. */
export const groupBlockCatalogByCategory = (
  entries: BlockCatalogEntry[],
): { category: BlockCategory; entries: BlockCatalogEntry[] }[] =>
  BLOCK_CATEGORIES.map((category) => ({
    category,
    entries: entries.filter((entry) => entry.category === category),
  })).filter((group) => group.entries.length > 0)
