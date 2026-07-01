/**
 * English strings for the editor surface (Super editor toolbar, block/insert
 * menus, formatting controls, note editor chrome). Source of truth: other
 * locales fall back to these until translated. Keys added here automatically
 * become part of the translatable surface.
 */
const editor = {
  // Clipboard
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  moreCutOptions: 'More cut options',
  moreCopyOptions: 'More copy options',
  morePasteOptions: 'More paste options',

  // History / navigation
  tableOfContents: 'Table of Contents',
  selectAll: 'Select all',
  selectAllText: 'Select all text only',
  deselectAll: 'Deselect all',
  search: 'Search',
  undo: 'Undo',
  redo: 'Redo',
  undoHistory: 'Undo history',
  redoHistory: 'Redo history',
  undoHistoryEmpty: 'Undo history — nothing to undo yet',
  undoHistoryAvailable: 'Undo history — go back several steps at once',
  redoHistoryEmpty: 'Redo history — nothing to redo',
  redoHistoryAvailable: 'Redo history — jump forward several steps at once',

  // Text formatting
  formattingOptions: 'Formatting options',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strikethrough: 'Strikethrough',
  inlineCode: 'Inline Code',
  link: 'Link',
  formatPainter: 'Format painter — copy formatting (double-click to keep on)',
  textStyle: 'Text style',
  textColor: 'Text color',
  highlightColor: 'Highlight color',
  typography: 'Typography — emphasis, outline, letter & word spacing',
  typographyTitle: 'Typography',

  // Font size / family
  fontSize: 'Font size',
  chooseFontSize: 'Choose font size',
  decreaseFontSize: 'Decrease font size',
  increaseFontSize: 'Increase font size',
  fontFamily: 'Font family',
  customFontFamily: 'Custom',

  // Blocks / lists
  bulletedList: 'Bulleted List',
  numberedList: 'Numbered List',
  checkList: 'Check List',
  quote: 'Quote',
  codeBlock: 'Code Block',
  changeCase: 'Change case',
  sortAndDedupeLines: 'Sort & dedupe lines',
  alignment: 'Alignment',
  paragraphLayout: 'Paragraph layout — line & paragraph spacing, indentation, shading',
  paragraphLayoutTitle: 'Paragraph layout',
  listStyleMarker: 'List style — bullet & number marker',
  formattingMarks: 'Formatting marks',
  insert: 'Insert',

  // Contextual table tools
  insertRowAbove: 'Insert row above',
  insertRowBelow: 'Insert row below',
  insertColumnLeft: 'Insert column left',
  insertColumnRight: 'Insert column right',
  deleteRow: 'Delete row',
  deleteColumn: 'Delete column',
  toggleRowHeader: 'Toggle row header',
  toggleColumnHeader: 'Toggle column header',
  deleteTable: 'Delete table',

  // Contextual ribbon segment captions (Office-style grouping)
  rows: 'Rows',
  columns: 'Columns',
  cells: 'Cells',
  table: 'Table',
  block: 'Block',

  // Contextual image tools
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',

  // Contextual link tools
  editLink: 'Edit link',
  removeLink: 'Remove link',

  // Zoom
  zoomIntoBlock: 'Zoom into block',

  // Floating selection toolbar
  blockStyle: 'Block style',
  heading1: 'Heading 1',
  heading2: 'Heading 2',
  heading3: 'Heading 3',
  normalText: 'Normal text',
  moreFormatting: 'More formatting',

  // Note from selection
  createNoteFromSelectionTitle: 'Create new note from selection',
  createNoteFromSelectionDescription:
    'Creates a new note containing the current selection and replaces the selection with a link to the new note.',

  // Mobile
  dismissKeyboard: 'Dismiss keyboard',

  // Popover titles / a11y labels
  tableOfContentsLower: 'Table of contents',
  noHeadingsFound: 'No headings found',
  textFormattingOptions: 'Text formatting options',
  highlight: 'Highlight',
  subscript: 'Subscript',
  superscript: 'Superscript',
  clearFormatting: 'Clear formatting',
  normal: 'Normal',
  smartChecklist: 'Smart checklist',
  restoreCompletedTasks: 'Restore completed tasks',
  leftAlign: 'Left align',
  centerAlign: 'Center align',
  rightAlign: 'Right align',
  justify: 'Justify',

  // Insert menu
  searchBlocksPlaceholder: 'Search blocks…',
  searchBlocksToInsert: 'Search blocks to insert',
  clearSearch: 'Clear search',
  noBlocksMatch: 'No blocks match “{{query}}”',
  customizeToolbar: 'Customize toolbar',

  // Color popovers
  custom: 'Custom',
  clear: 'Clear',
  textColorSwatch: 'Text color {{color}}',
  highlightColorSwatch: 'Highlight color {{color}}',
  textShadingSwatch: 'Text shading {{color}}',
  noTextShading: 'No text shading',

  // Change case
  uppercase: 'UPPERCASE',
  lowercase: 'lowercase',
  camelCase: 'camelCase',

  // Sort lines
  sortLines: 'Sort lines',
  deduplicate: 'Deduplicate',
  multiKeySort: 'Multi-key sort (1st, 2nd, 3rd)…',
  sortAndDeduplicateLines: 'Sort and deduplicate lines',

  // Typography popover
  emphasisMarks: 'Emphasis marks',
  outlineTextStroke: 'Outline (text stroke)',
  letterSpacingKerning: 'Letter spacing (kerning)',
  wordSpacing: 'Word spacing',
  clearTypography: 'Clear typography',
  spacingTight: 'Tight',
  spacingNormal: 'Normal',
  spacingWide: 'Wide',
  spacingWider: 'Wider',
  spacingWidest: 'Widest',

  // History popovers
  undoMultipleSteps: 'Undo multiple steps',
  redoMultipleSteps: 'Redo multiple steps',
  emptyHistoryPreview: '(empty)',

  // Clipboard option menus
  pasteOptions: 'Paste options',
  copyOptions: 'Copy options',
  cutOptions: 'Cut options',
  pasteWithoutFormatting: 'Paste without formatting',
  pasteClean: 'Paste clean (strip hidden characters)',
  keepSourceFormatting: 'Keep source formatting',
  matchDestinationFormatting: 'Match destination formatting',
  pasteAsImage: 'Paste as image',
  copyWithoutFormatting: 'Copy without formatting',
  copyTextOnly: 'Copy text only',
  copyImagesOnly: 'Copy images only',
  cutWithoutFormatting: 'Cut without formatting',
  cutTextOnly: 'Cut text only',
  cutImagesOnly: 'Cut images only',

  // Paragraph layout popover
  lineSpacing: 'Line spacing',
  spaceBefore: 'Space before',
  spaceAfter: 'Space after',
  indentation: 'Indentation',
  none: 'None',
  increaseLeft: 'Increase left',
  decreaseLeft: 'Decrease left',
  increaseRight: 'Increase right',
  decreaseRight: 'Decrease right',
  firstLine: 'First line',
  noFirstLine: 'No first line',
  textShading: 'Text shading',

  // List style popover
  listStyle: 'List style',
  bulleted: 'Bulleted',
  numbered: 'Numbered',
  bulletedListMarkers: 'Bullet marker style',
  numberedListMarkers: 'Numbering style',
  multilevelList: 'Multilevel list',
  multilevelListHint: 'Choose a marker per nesting level',
  multilevelLevelDefault: 'Default',
  level: 'Level',
  apply: 'Apply',

  // Modal titles
  insertTable: 'Insert Table',
  insertImageFromUrl: 'Insert image from URL',
  sortLinesModalTitle: 'Sort lines',

  // Block picker
  blockPicker: 'Block picker',

  // Block catalog display names (Insert menu + slash picker). The English value
  // here must match the catalog's source name exactly; search still matches on
  // the original English string, so these are display-only.
  blockParagraph: 'Paragraph',
  blockCallout: 'Callout',
  blockDivider: 'Divider',
  blockCollapsible: 'Collapsible',
  blockImageFromUrl: 'Image from URL',
  blockUploadFile: 'Upload file',
  blockDrawing: 'Drawing',
  blockQrCode: 'QR Code',
  blockTable: 'Table',
  blockKanbanBoard: 'Kanban Board',
  blockCalendar: 'Calendar',
  blockTimeline: 'Timeline',
  blockDataTable: 'Data Table',
  blockSqlQuery: 'SQL Query',
  blockMermaidDiagram: 'Mermaid Diagram',
  blockGanttChart: 'Gantt Chart',
  blockTimingDiagram: 'Timing Diagram',
  blockMusicStaff: 'Music Staff',
  blockTradingViewChart: 'TradingView Chart',
  blockStockChart: 'Stock Chart',
  blockEmbed: 'Embed',
  blockEmbedWebsite: 'Embed website',
  blockTweet: 'Tweet',
  blockEquation: 'Equation',
  blockInlineEquation: 'Inline Equation',
  blockFootnote: 'Footnote',
  blockBookmark: 'Bookmark',
  blockGeneratePassword: 'Generate cryptographically secure password',
  blockClock: 'Clock',
  blockCurrentDateTime: 'Current date and time',
  blockCurrentTime: 'Current time',
  blockCurrentDate: 'Current date',

  // Block catalog category headers
  blockCategoryBasic: 'Basic',
  blockCategoryLists: 'Lists',
  blockCategoryMedia: 'Media',
  blockCategoryDataTables: 'Data & tables',
  blockCategoryDiagramsCharts: 'Diagrams & charts',
  blockCategoryFinance: 'Finance',
  blockCategoryEmbeds: 'Embeds',
  blockCategoryAdvanced: 'Advanced',
}

export default editor
