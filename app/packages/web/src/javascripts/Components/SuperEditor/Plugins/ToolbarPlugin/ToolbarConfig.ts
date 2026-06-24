/**
 * Standard Red Notes: declarative description of the Super editor toolbar so it
 * can be driven from a persisted, user-customizable config instead of hardcoded
 * JSX. The actual button JSX still lives in ToolbarPlugin.tsx (it closes over a
 * lot of editor state); this module only owns the *identity, grouping, labels,
 * and ordering* of buttons plus the pure logic that applies a saved config.
 *
 * Stable string ids are the contract between the persisted config and the
 * rendered buttons — never rename an existing id, only add/deprecate.
 */

/** Stable group ids, in their default left-to-right order. */
export enum ToolbarGroupId {
  Clipboard = 'clipboard',
  History = 'history',
  BlockStyle = 'blockStyle',
  TextStyle = 'textStyle',
  ColorFont = 'colorFont',
  ParagraphList = 'paragraphList',
  Insert = 'insert',
  AI = 'ai',
}

/** Stable button ids. Keep in sync with the render map in ToolbarPlugin.tsx. */
export enum ToolbarButtonId {
  // Clipboard
  Cut = 'cut',
  Copy = 'copy',
  Paste = 'paste',
  // History / navigation
  TableOfContents = 'tableOfContents',
  Search = 'search',
  Undo = 'undo',
  Redo = 'redo',
  // Block style
  BlockStyle = 'blockStyle',
  // Text style
  Bold = 'bold',
  Italic = 'italic',
  Underline = 'underline',
  InlineCode = 'inlineCode',
  Link = 'link',
  TextStyleMenu = 'textStyleMenu',
  // Color / font
  TextColor = 'textColor',
  HighlightColor = 'highlightColor',
  DecreaseFontSize = 'decreaseFontSize',
  IncreaseFontSize = 'increaseFontSize',
  FontFamily = 'fontFamily',
  FontSize = 'fontSize',
  // Paragraph / list
  BulletedList = 'bulletedList',
  NumberedList = 'numberedList',
  CodeBlock = 'codeBlock',
  ChangeCase = 'changeCase',
  SortLines = 'sortLines',
  Alignment = 'alignment',
  Indent = 'indent',
  Outdent = 'outdent',
  // Insert
  InsertMenu = 'insertMenu',
  NoteFromSelection = 'noteFromSelection',
  // AI
  AI = 'ai',
}

export type ToolbarButtonDescriptor = {
  id: ToolbarButtonId
  /** Human-readable label shown in the customizer. */
  label: string
  group: ToolbarGroupId
}

export type ToolbarGroupDescriptor = {
  id: ToolbarGroupId
  label: string
  /** Short title shown beneath the group in the toolbar (Office-ribbon style). */
  caption?: string
  buttons: ToolbarButtonDescriptor[]
}

/**
 * The full, default toolbar definition. Order here IS the default order
 * (groups top-to-bottom, buttons within each group left-to-right).
 */
export const DEFAULT_TOOLBAR_GROUPS: ToolbarGroupDescriptor[] = [
  {
    id: ToolbarGroupId.Clipboard,
    label: 'Clipboard',
    caption: 'Clipboard',
    buttons: [
      { id: ToolbarButtonId.Cut, label: 'Cut', group: ToolbarGroupId.Clipboard },
      { id: ToolbarButtonId.Copy, label: 'Copy', group: ToolbarGroupId.Clipboard },
      { id: ToolbarButtonId.Paste, label: 'Paste', group: ToolbarGroupId.Clipboard },
    ],
  },
  {
    id: ToolbarGroupId.History,
    label: 'History & navigation',
    caption: 'History',
    buttons: [
      { id: ToolbarButtonId.TableOfContents, label: 'Table of Contents', group: ToolbarGroupId.History },
      { id: ToolbarButtonId.Search, label: 'Search', group: ToolbarGroupId.History },
      { id: ToolbarButtonId.Undo, label: 'Undo', group: ToolbarGroupId.History },
      { id: ToolbarButtonId.Redo, label: 'Redo', group: ToolbarGroupId.History },
    ],
  },
  {
    id: ToolbarGroupId.BlockStyle,
    label: 'Block style',
    caption: 'Block',
    buttons: [{ id: ToolbarButtonId.BlockStyle, label: 'Formatting options', group: ToolbarGroupId.BlockStyle }],
  },
  {
    id: ToolbarGroupId.TextStyle,
    label: 'Text style',
    caption: 'Text',
    buttons: [
      { id: ToolbarButtonId.Bold, label: 'Bold', group: ToolbarGroupId.TextStyle },
      { id: ToolbarButtonId.Italic, label: 'Italic', group: ToolbarGroupId.TextStyle },
      { id: ToolbarButtonId.Underline, label: 'Underline', group: ToolbarGroupId.TextStyle },
      { id: ToolbarButtonId.InlineCode, label: 'Inline Code', group: ToolbarGroupId.TextStyle },
      { id: ToolbarButtonId.Link, label: 'Link', group: ToolbarGroupId.TextStyle },
      { id: ToolbarButtonId.TextStyleMenu, label: 'Text style menu', group: ToolbarGroupId.TextStyle },
    ],
  },
  {
    id: ToolbarGroupId.ColorFont,
    label: 'Font',
    caption: 'Font',
    buttons: [
      { id: ToolbarButtonId.FontFamily, label: 'Font family', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.FontSize, label: 'Font size', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.DecreaseFontSize, label: 'Decrease font size', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.IncreaseFontSize, label: 'Increase font size', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.TextColor, label: 'Text color', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.HighlightColor, label: 'Highlight color', group: ToolbarGroupId.ColorFont },
    ],
  },
  {
    id: ToolbarGroupId.ParagraphList,
    label: 'Paragraph & lists',
    caption: 'Paragraph',
    buttons: [
      { id: ToolbarButtonId.BulletedList, label: 'Bulleted List', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.NumberedList, label: 'Numbered List', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.CodeBlock, label: 'Code Block', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.ChangeCase, label: 'Change case', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.SortLines, label: 'Sort & dedupe lines', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Alignment, label: 'Alignment', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Indent, label: 'Indent', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Outdent, label: 'Outdent', group: ToolbarGroupId.ParagraphList },
    ],
  },
  {
    id: ToolbarGroupId.Insert,
    label: 'Insert',
    caption: 'Insert',
    buttons: [
      { id: ToolbarButtonId.InsertMenu, label: 'Insert menu', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.NoteFromSelection, label: 'Create note from selection', group: ToolbarGroupId.Insert },
    ],
  },
  {
    id: ToolbarGroupId.AI,
    label: 'AI',
    caption: 'AI',
    buttons: [{ id: ToolbarButtonId.AI, label: 'AI tools', group: ToolbarGroupId.AI }],
  },
]

/**
 * Persisted shape. `groupOrder` is a list of group ids (any not listed fall back
 * to their default position, appended in default order). `hiddenButtonIds` lists
 * buttons the user has turned off. Empty arrays == full default set (no-op).
 *
 * Kept as plain `string[]` to structurally match the `SuperToolbarConfig` local
 * pref declared in @standardnotes/services (which can't import these web-side
 * enums). Values are always one of the `ToolbarGroupId` / `ToolbarButtonId`
 * string literals; `normalizeToolbarConfig` guarantees that at runtime.
 */
export type SuperToolbarConfig = {
  groupOrder: string[]
  hiddenButtonIds: string[]
}

export const DEFAULT_SUPER_TOOLBAR_CONFIG: SuperToolbarConfig = {
  groupOrder: [],
  hiddenButtonIds: [],
}

const ALL_GROUP_IDS = new Set<string>(DEFAULT_TOOLBAR_GROUPS.map((g) => g.id))
const ALL_BUTTON_IDS = new Set<string>(
  DEFAULT_TOOLBAR_GROUPS.flatMap((g) => g.buttons.map((b) => b.id)),
)

/**
 * Coerce an arbitrary (possibly malformed / partially-known) persisted value
 * into a safe SuperToolbarConfig. Unknown ids are dropped; missing fields fall
 * back to default. Never throws.
 */
export function normalizeToolbarConfig(raw: unknown): SuperToolbarConfig {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_SUPER_TOOLBAR_CONFIG
  }

  const candidate = raw as Partial<Record<keyof SuperToolbarConfig, unknown>>

  const groupOrder = Array.isArray(candidate.groupOrder)
    ? (candidate.groupOrder.filter(
        (id, index, arr) => typeof id === 'string' && ALL_GROUP_IDS.has(id) && arr.indexOf(id) === index,
      ) as ToolbarGroupId[])
    : []

  const hiddenButtonIds = Array.isArray(candidate.hiddenButtonIds)
    ? (candidate.hiddenButtonIds.filter(
        (id, index, arr) => typeof id === 'string' && ALL_BUTTON_IDS.has(id) && arr.indexOf(id) === index,
      ) as ToolbarButtonId[])
    : []

  return { groupOrder, hiddenButtonIds }
}

/**
 * Apply a (already-normalized OR raw) config to the default group list,
 * producing the ordered, filtered groups to render. Groups left empty after
 * hiding their buttons are dropped so no dangling separators remain.
 *
 * Guarantees: a default/empty config returns the full default set in default
 * order (deep-equal to DEFAULT_TOOLBAR_GROUPS); malformed input falls back to
 * default; never mutates DEFAULT_TOOLBAR_GROUPS.
 */
export function applyToolbarConfig(
  rawConfig: unknown,
  groups: ToolbarGroupDescriptor[] = DEFAULT_TOOLBAR_GROUPS,
): ToolbarGroupDescriptor[] {
  const config = normalizeToolbarConfig(rawConfig)
  const hidden = new Set<string>(config.hiddenButtonIds)

  const byId = new Map(groups.map((g) => [g.id, g]))

  // Ordered group list: explicit order first, then any remaining default groups
  // in their default order.
  const orderedGroupIds: ToolbarGroupId[] = []
  const seen = new Set<string>()
  for (const rawId of config.groupOrder) {
    // normalizeToolbarConfig already dropped unknown ids, so this cast is safe.
    const id = rawId as ToolbarGroupId
    if (byId.has(id) && !seen.has(id)) {
      orderedGroupIds.push(id)
      seen.add(id)
    }
  }
  for (const group of groups) {
    if (!seen.has(group.id)) {
      orderedGroupIds.push(group.id)
      seen.add(group.id)
    }
  }

  const result: ToolbarGroupDescriptor[] = []
  for (const groupId of orderedGroupIds) {
    const group = byId.get(groupId)
    if (!group) {
      continue
    }
    const buttons = group.buttons.filter((b) => !hidden.has(b.id))
    if (buttons.length === 0) {
      continue
    }
    result.push({ ...group, buttons })
  }

  return result
}
