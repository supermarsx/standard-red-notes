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
  Toolbar = 'toolbar',
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
  FormatPainter = 'formatPainter',
  TextStyleMenu = 'textStyleMenu',
  // Color / font
  TextColor = 'textColor',
  HighlightColor = 'highlightColor',
  DecreaseFontSize = 'decreaseFontSize',
  IncreaseFontSize = 'increaseFontSize',
  /** Combined A-/A+ stepper that keeps decrease + increase on one line. */
  FontSizeStepper = 'fontSizeStepper',
  FontFamily = 'fontFamily',
  FontSize = 'fontSize',
  Typography = 'typography',
  // Paragraph / list
  BulletedList = 'bulletedList',
  NumberedList = 'numberedList',
  Quote = 'quote',
  CodeBlock = 'codeBlock',
  ChangeCase = 'changeCase',
  SortLines = 'sortLines',
  Alignment = 'alignment',
  Indent = 'indent',
  Outdent = 'outdent',
  ParagraphLayout = 'paragraphLayout',
  ListStyle = 'listStyle',
  FormattingMarks = 'formattingMarks',
  // Insert
  InsertMenu = 'insertMenu',
  InsertTable = 'insertTable',
  InsertImageFile = 'insertImageFile',
  InsertDrawing = 'insertDrawing',
  InsertEquation = 'insertEquation',
  InsertFootnote = 'insertFootnote',
  NoteFromSelection = 'noteFromSelection',
  Dictation = 'dictation',
  // AI
  AI = 'ai',
  // Toolbar
  CustomizeToolbar = 'customizeToolbar',
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
  /**
   * How many rows the group's buttons may wrap onto (1–3). Set by the user's
   * per-group `groupRows` config; `applyToolbarConfig` populates it. When unset
   * the toolbar treats the group as a single row (default).
   */
  rows?: number
}

/** Minimum / maximum / default rows a group may wrap its buttons onto. */
export const MIN_GROUP_ROWS = 1
export const MAX_GROUP_ROWS = 3
export const DEFAULT_GROUP_ROWS = 1

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
      { id: ToolbarButtonId.FormatPainter, label: 'Format painter', group: ToolbarGroupId.TextStyle },
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
      { id: ToolbarButtonId.FontSizeStepper, label: 'Font size +/-', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.TextColor, label: 'Text color', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.HighlightColor, label: 'Highlight color', group: ToolbarGroupId.ColorFont },
      { id: ToolbarButtonId.Typography, label: 'Typography (emphasis, outline, spacing)', group: ToolbarGroupId.ColorFont },
    ],
  },
  {
    id: ToolbarGroupId.ParagraphList,
    label: 'Paragraph & lists',
    caption: 'Paragraph',
    buttons: [
      { id: ToolbarButtonId.BulletedList, label: 'Bulleted List', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.NumberedList, label: 'Numbered List', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Quote, label: 'Quote', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.CodeBlock, label: 'Code Block', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.ChangeCase, label: 'Change case', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.SortLines, label: 'Sort & dedupe lines', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Alignment, label: 'Alignment', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Indent, label: 'Indent', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.Outdent, label: 'Outdent', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.ParagraphLayout, label: 'Paragraph layout (spacing, indent, shading)', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.ListStyle, label: 'List style', group: ToolbarGroupId.ParagraphList },
      { id: ToolbarButtonId.FormattingMarks, label: 'Formatting marks', group: ToolbarGroupId.ParagraphList },
    ],
  },
  {
    id: ToolbarGroupId.Insert,
    label: 'Insert',
    caption: 'Insert',
    buttons: [
      { id: ToolbarButtonId.InsertMenu, label: 'Insert menu', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.InsertTable, label: 'Insert table', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.InsertImageFile, label: 'Insert image or file', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.InsertDrawing, label: 'Insert drawing', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.InsertEquation, label: 'Insert equation', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.InsertFootnote, label: 'Insert footnote', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.NoteFromSelection, label: 'Create note from selection', group: ToolbarGroupId.Insert },
      { id: ToolbarButtonId.Dictation, label: 'Dictate (speech-to-text)', group: ToolbarGroupId.Insert },
    ],
  },
  {
    id: ToolbarGroupId.AI,
    label: 'AI',
    caption: 'AI',
    buttons: [{ id: ToolbarButtonId.AI, label: 'AI tools', group: ToolbarGroupId.AI }],
  },
  {
    id: ToolbarGroupId.Toolbar,
    label: 'Toolbar',
    caption: 'Toolbar',
    buttons: [{ id: ToolbarButtonId.CustomizeToolbar, label: 'Customize toolbar', group: ToolbarGroupId.Toolbar }],
  },
]

/**
 * Office-ribbon "super groups": the top-level tabs that each contain a set of the
 * segmented groups above. Only the active super group's groups render at once, so
 * the toolbar fits without horizontal scrolling unless a single tab is very tight.
 */
export enum ToolbarSuperGroupId {
  Home = 'home',
  Insert = 'insert',
  AI = 'aiTab',
  Tools = 'tools',
}

export type ToolbarSuperGroupDescriptor = {
  id: ToolbarSuperGroupId
  label: string
  /** The segmented groups (by id) shown when this tab is active, in order. */
  groups: ToolbarGroupId[]
}

/**
 * Default tab → groups mapping. Any group not listed here is appended to the
 * first (Home) tab so nothing can ever be orphaned/hidden.
 */
export const DEFAULT_SUPER_GROUPS: ToolbarSuperGroupDescriptor[] = [
  {
    id: ToolbarSuperGroupId.Home,
    label: 'Home',
    groups: [
      ToolbarGroupId.Clipboard,
      ToolbarGroupId.History,
      ToolbarGroupId.BlockStyle,
      ToolbarGroupId.TextStyle,
      ToolbarGroupId.ColorFont,
      ToolbarGroupId.ParagraphList,
    ],
  },
  { id: ToolbarSuperGroupId.Insert, label: 'Insert', groups: [ToolbarGroupId.Insert] },
  { id: ToolbarSuperGroupId.AI, label: 'AI', groups: [ToolbarGroupId.AI] },
  { id: ToolbarSuperGroupId.Tools, label: 'Tools', groups: [ToolbarGroupId.Toolbar] },
]

/**
 * Partition the resolved (ordered, filtered) groups into their super-group tabs,
 * dropping empty tabs. Groups not assigned to any tab are appended to the first
 * tab. Pure — safe to call in render.
 */
export function groupsBySuperGroup<T extends { id: ToolbarGroupId | string }>(
  groups: T[],
): { id: ToolbarSuperGroupId; label: string; groups: T[] }[] {
  const byId = new Map(groups.map((group) => [group.id as string, group]))
  const assigned = new Set<string>()

  const tabs = DEFAULT_SUPER_GROUPS.map((superGroup) => {
    const tabGroups: T[] = []
    for (const groupId of superGroup.groups) {
      const group = byId.get(groupId)
      if (group) {
        tabGroups.push(group)
        assigned.add(groupId)
      }
    }
    return { id: superGroup.id, label: superGroup.label, groups: tabGroups }
  })

  // Append any unmapped groups to the first tab so they remain reachable.
  const leftovers = groups.filter((group) => !assigned.has(group.id as string))
  if (leftovers.length > 0 && tabs.length > 0) {
    tabs[0].groups.push(...leftovers)
  }

  return tabs.filter((tab) => tab.groups.length > 0)
}

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
  /**
   * Per-group ordered button ids. A group key maps to the order its buttons
   * should appear in; ids not listed fall back to their default position
   * (appended in default order). Unknown groups/buttons are dropped.
   */
  buttonOrder?: Record<string, string[]>
  /** Per-group number of rows the buttons may wrap onto (clamped 1–3). */
  groupRows?: Record<string, number>
  /**
   * When true, the toolbar stays on a single line with horizontal scroll
   * (legacy behavior). Default/undefined == wrap onto multiple lines.
   */
  horizontalScroll?: boolean
}

export const DEFAULT_SUPER_TOOLBAR_CONFIG: SuperToolbarConfig = {
  groupOrder: [],
  hiddenButtonIds: [],
}

const ALL_GROUP_IDS = new Set<string>(DEFAULT_TOOLBAR_GROUPS.map((g) => g.id))
const ALL_BUTTON_IDS = new Set<string>(
  DEFAULT_TOOLBAR_GROUPS.flatMap((g) => g.buttons.map((b) => b.id)),
)
/** group id -> set of button ids that legitimately belong to that group. */
const BUTTON_IDS_BY_GROUP = new Map<string, Set<string>>(
  DEFAULT_TOOLBAR_GROUPS.map((g) => [g.id, new Set<string>(g.buttons.map((b) => b.id))]),
)

const clampRows = (value: number): number =>
  Math.min(MAX_GROUP_ROWS, Math.max(MIN_GROUP_ROWS, Math.round(value)))

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

  const result: SuperToolbarConfig = { groupOrder, hiddenButtonIds }

  // buttonOrder: keep only known groups, and within each only that group's own
  // (unique) button ids. Empty / fully-invalid maps are dropped so the default
  // config stays a literal `{ groupOrder: [], hiddenButtonIds: [] }`.
  if (candidate.buttonOrder && typeof candidate.buttonOrder === 'object' && !Array.isArray(candidate.buttonOrder)) {
    const cleaned: Record<string, string[]> = {}
    for (const [groupId, ids] of Object.entries(candidate.buttonOrder as Record<string, unknown>)) {
      const validIds = BUTTON_IDS_BY_GROUP.get(groupId)
      if (!validIds || !Array.isArray(ids)) {
        continue
      }
      const order = ids.filter(
        (id, index, arr) => typeof id === 'string' && validIds.has(id) && arr.indexOf(id) === index,
      ) as string[]
      if (order.length > 0) {
        cleaned[groupId] = order
      }
    }
    if (Object.keys(cleaned).length > 0) {
      result.buttonOrder = cleaned
    }
  }

  // groupRows: keep only known groups with a finite, clamped (1–3) row count
  // that differs from the default (DEFAULT_GROUP_ROWS), so a default config is a
  // literal no-op.
  if (candidate.groupRows && typeof candidate.groupRows === 'object' && !Array.isArray(candidate.groupRows)) {
    const cleaned: Record<string, number> = {}
    for (const [groupId, rows] of Object.entries(candidate.groupRows as Record<string, unknown>)) {
      if (!ALL_GROUP_IDS.has(groupId) || typeof rows !== 'number' || !Number.isFinite(rows)) {
        continue
      }
      const clamped = clampRows(rows)
      if (clamped !== DEFAULT_GROUP_ROWS) {
        cleaned[groupId] = clamped
      }
    }
    if (Object.keys(cleaned).length > 0) {
      result.groupRows = cleaned
    }
  }

  // horizontalScroll: only retained when explicitly true (false == default).
  if (candidate.horizontalScroll === true) {
    result.horizontalScroll = true
  }

  return result
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

    // Apply per-group button ordering (explicit ids first, remaining defaults
    // appended in default order), then drop hidden buttons.
    let buttons = group.buttons
    const order = config.buttonOrder?.[groupId]
    if (order && order.length > 0) {
      const buttonById = new Map(group.buttons.map((b) => [b.id as string, b]))
      const ordered: typeof group.buttons = []
      const placed = new Set<string>()
      for (const id of order) {
        const btn = buttonById.get(id)
        if (btn && !placed.has(id)) {
          ordered.push(btn)
          placed.add(id)
        }
      }
      for (const btn of group.buttons) {
        if (!placed.has(btn.id)) {
          ordered.push(btn)
          placed.add(btn.id)
        }
      }
      buttons = ordered
    }

    buttons = buttons.filter((b) => !hidden.has(b.id))
    if (buttons.length === 0) {
      continue
    }

    // Only attach `rows` when the user overrode it, so a default config stays
    // deep-equal to DEFAULT_TOOLBAR_GROUPS (no stray `rows` key).
    const rows = config.groupRows?.[groupId]
    if (rows != null && rows !== DEFAULT_GROUP_ROWS) {
      result.push({ ...group, buttons, rows })
    } else {
      result.push({ ...group, buttons })
    }
  }

  return result
}
