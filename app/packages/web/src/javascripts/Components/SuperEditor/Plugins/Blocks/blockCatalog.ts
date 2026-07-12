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
import { CommentBlock } from './Comment'
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
  openInsertSymbolPicker: () => void
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
  fromBlock(CommentBlock, 'Basic'),
  fromBlock(DividerBlock, 'Basic'),
  fromBlock(PageBreakBlock, 'Basic'),
  fromBlock(CollapsibleBlock, 'Basic'),
  {
    key: 'Symbol',
    name: 'Symbol',
    iconName: 'plain-text',
    keywords: [
      'symbol',
      'special character',
      'character',
      'unicode',
      'glyph',
      'omega',
      'arrow',
      'math',
      'greek',
      'currency',
      'punctuation',
      'emoji',
    ],
    category: 'Basic',
    onSelect: (_editor, ctx) => ctx.openInsertSymbolPicker(),
  },

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

/**
 * Stable identity of the always-visible Insert-tab sections. The first six map
 * 1:1 onto a catalog category; `others` is the trailing catch-all that folds the
 * low-frequency `Embeds` + `Advanced` categories (and, in the toolbar, the three
 * non-catalog Insert actions Link / Create-note-from-selection / Dictate).
 */
export type InsertSectionId =
  | 'basic'
  | 'lists'
  | 'media'
  | 'dataTables'
  | 'diagramsCharts'
  | 'finance'
  | 'others'

export type InsertSection = { id: InsertSectionId; entries: BlockCatalogEntry[] }

/** Category -> section. `Embeds` + `Advanced` collapse into the trailing "Others" bucket. */
const SECTION_BY_CATEGORY: Record<BlockCategory, InsertSectionId> = {
  Basic: 'basic',
  Lists: 'lists',
  Media: 'media',
  'Data & tables': 'dataTables',
  'Diagrams & charts': 'diagramsCharts',
  Finance: 'finance',
  Embeds: 'others',
  Advanced: 'others',
}

/** Fixed display order of the Insert-tab sections. */
export const INSERT_SECTION_ORDER: InsertSectionId[] = [
  'basic',
  'lists',
  'media',
  'dataTables',
  'diagramsCharts',
  'finance',
  'others',
]

/**
 * Group a (full) catalog into the fixed, ordered Insert sections, dropping any
 * section that ends up empty. Pure and i18n-free (returns stable section ids;
 * the toolbar translates captions), so the mapping is trivially unit-testable.
 */
export const buildInsertSections = (entries: BlockCatalogEntry[]): InsertSection[] =>
  INSERT_SECTION_ORDER.map((id) => ({
    id,
    entries: entries.filter((entry) => SECTION_BY_CATEGORY[entry.category] === id),
  })).filter((section) => section.entries.length > 0)
