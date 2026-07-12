/**
 * Standard Red Notes: Typography Profiles — Phase 2 (preview-square gallery).
 *
 * The data + apply glue behind the toolbar's "block style gallery": a grid of
 * little squares, each a truthful static preview of one block type as styled by
 * the ACTIVE typography profile (Phase 1). Clicking a square (a) converts the
 * current selection to that block TYPE — reusing the existing block ops in
 * `Plugins/Blocks/*` — and (b) stamps the active profile's style for that block
 * as a PER-BLOCK override via blockFormatting's `$applyBlockStyleEntries` (#77),
 * which persists onto the Styled* node inline style.
 *
 * This module owns no React — it is the pure metadata + editor-side handler so
 * the rendering (BlockStyleGallery.tsx) stays a thin presentational layer.
 */
import { $getSelection, $isRangeSelection, LexicalEditor } from 'lexical'
import type { BlockStyle, BlockTypeKey, TypographyProfile } from '@standardnotes/models'
import { blockStyleToStyleEntries } from '@/Utils/typographyProfiles'
import { $applyBlockStyleEntries, parseStyleString } from './blockFormatting'
import { ParagraphBlock } from '../Blocks/Paragraph'
import { H1Block, H2Block, H3Block, H4Block, H5Block } from '../Blocks/Headings'
import { QuoteBlock } from '../Blocks/Quote'
import { CodeBlock } from '../Blocks/Code'
import { BulletedListBlock, NumberedListBlock, ChecklistBlock } from '../Blocks/List'

/** How a preview square renders the sample block element. */
export type PreviewKind = 'block' | 'ul' | 'ol' | 'checklist'

export type GalleryBlockDescriptor = {
  /** The profile / model block-type key this square styles. */
  key: BlockTypeKey
  /** Short display label under the square. */
  label: string
  /** Icon name (shared with the toolbar block-type set). */
  iconName: string
  /**
   * The real Lexical theme class for this block (from `Lexical/Theme/Theme.ts`),
   * so the square inherits the block's genuine base appearance; the active
   * profile's style is layered on top as an inline override.
   */
  themeClass: string
  /** Which element to render for a truthful preview. */
  kind: PreviewKind
  /** Sample text shown inside the square. */
  sample: string
  /** Convert the current selection to this block type, reusing the block op. */
  setType: (editor: LexicalEditor) => void
  /**
   * A built-in defining style baked into code, for paragraph *variants* (Title,
   * Normal-spaced, Accented, Strong, Emphasis) that share `.Lexical__paragraph`
   * and therefore have no distinguishing theme class / scoped-CSS rule. At apply
   * time and in every preview the effective style is `{ ...baseStyle,
   * ...profileOverride }` (a profile edit wins per property), so the variant's
   * identity always survives even in a fresh profile. Real block types (headings,
   * quote, code, lists) leave this undefined — their appearance comes from the
   * theme class + profile.
   */
  baseStyle?: BlockStyle
}

/**
 * The gallery blocks, in display order. Covers the block types with a clean,
 * reusable block op (paragraph / headings / quote / code / the three lists) —
 * matching the ops in `Plugins/Blocks/*`. Callout is intentionally excluded (it
 * has no simple type-conversion op and the theme styles it via a data-attribute
 * variant, not a plain class).
 */
export const GALLERY_BLOCKS: GalleryBlockDescriptor[] = [
  {
    key: 'paragraph',
    label: 'Normal',
    iconName: 'paragraph',
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Normal body text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
  },
  {
    key: 'normalSpaced',
    label: 'Normal (spaced)',
    iconName: 'plain-text',
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Spaced body text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
    baseStyle: {
      marginTop: '0',
      marginBottom: '0.75rem',
    },
  },
  {
    key: 'h1',
    label: 'Heading 1',
    iconName: 'h1',
    themeClass: 'Lexical__h1',
    kind: 'block',
    sample: 'Heading 1',
    setType: (editor) => H1Block.onSelect(editor),
  },
  {
    key: 'h2',
    label: 'Heading 2',
    iconName: 'h2',
    themeClass: 'Lexical__h2',
    kind: 'block',
    sample: 'Heading 2',
    setType: (editor) => H2Block.onSelect(editor),
  },
  {
    key: 'h3',
    label: 'Heading 3',
    iconName: 'h3',
    themeClass: 'Lexical__h3',
    kind: 'block',
    sample: 'Heading 3',
    setType: (editor) => H3Block.onSelect(editor),
  },
  {
    key: 'h4',
    label: 'Heading 4',
    iconName: 'h4',
    themeClass: 'Lexical__h4',
    kind: 'block',
    sample: 'Heading 4',
    setType: (editor) => H4Block.onSelect(editor),
  },
  {
    key: 'h5',
    label: 'Heading 5',
    iconName: 'h5',
    themeClass: 'Lexical__h5',
    kind: 'block',
    sample: 'Heading 5',
    setType: (editor) => H5Block.onSelect(editor),
  },
  {
    key: 'title',
    label: 'Title',
    iconName: 'text',
    // Renders as a styled paragraph (no heading semantics / not in the TOC); its
    // large-title look comes entirely from `baseStyle` layered over the paragraph.
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Title',
    setType: (editor) => ParagraphBlock.onSelect(editor),
    baseStyle: {
      fontSize: '2rem',
      fontWeight: '800',
      lineHeight: '1.2',
      color: 'var(--sn-stylekit-editor-foreground-color)',
      marginTop: '0',
      marginBottom: '0.5rem',
    },
  },
  {
    key: 'accented',
    label: 'Accented',
    iconName: 'star',
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Accented text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
    baseStyle: {
      color: 'var(--sn-stylekit-info-color)',
      fontWeight: '500',
    },
  },
  {
    key: 'strong',
    label: 'Strong',
    iconName: 'bold',
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Strong text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
    baseStyle: {
      fontWeight: '700',
    },
  },
  {
    key: 'emphasis',
    label: 'Emphasis',
    iconName: 'italic',
    themeClass: 'Lexical__paragraph',
    kind: 'block',
    sample: 'Emphasis text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
    baseStyle: {
      fontStyle: 'italic',
    },
  },
  {
    key: 'quote',
    label: 'Quote',
    iconName: 'quote',
    themeClass: 'Lexical__quote',
    kind: 'block',
    sample: 'A quoted line',
    setType: (editor) => QuoteBlock.onSelect(editor),
  },
  {
    key: 'code',
    label: 'Code',
    iconName: 'code',
    themeClass: 'Lexical__code',
    kind: 'block',
    sample: 'code();',
    setType: (editor) => CodeBlock.onSelect(editor),
  },
  {
    key: 'bulletList',
    label: 'Bulleted',
    iconName: 'list-bulleted',
    themeClass: 'Lexical__ul',
    kind: 'ul',
    sample: 'Bulleted item',
    setType: (editor) => BulletedListBlock.onSelect(editor),
  },
  {
    key: 'numberedList',
    label: 'Numbered',
    iconName: 'list-numbered',
    themeClass: 'Lexical__ol1',
    kind: 'ol',
    sample: 'Numbered item',
    setType: (editor) => NumberedListBlock.onSelect(editor),
  },
  {
    key: 'checkList',
    label: 'Checklist',
    iconName: 'list-check',
    themeClass: 'Lexical__checkList',
    kind: 'checklist',
    sample: 'Checklist item',
    setType: (editor) => ChecklistBlock.onSelect(editor),
  },
]

/** The built-in default display order (drives everything when the user hasn't reordered). */
export const DEFAULT_GALLERY_ORDER: BlockTypeKey[] = GALLERY_BLOCKS.map((d) => d.key)

/**
 * Resolve the user's saved gallery order into concrete descriptors:
 *  - saved keys map to descriptors in saved order (unknown/stale keys and duplicates dropped);
 *  - any descriptor NOT named in the saved order is appended in default (GALLERY_BLOCKS) order,
 *    so block styles added after the user's last reorder always appear (at the end);
 *  - an empty / missing order yields the full default order.
 * Pure; order-INDEPENDENT of detection (see resolveActiveGalleryKey note below).
 */
export const orderGalleryBlocks = (order: readonly BlockTypeKey[] | null | undefined): GalleryBlockDescriptor[] => {
  const byKey = new Map(GALLERY_BLOCKS.map((d) => [d.key, d]))
  const seen = new Set<BlockTypeKey>()
  const ordered: GalleryBlockDescriptor[] = []
  for (const key of order ?? []) {
    const descriptor = byKey.get(key)
    if (descriptor && !seen.has(key)) {
      ordered.push(descriptor)
      seen.add(key)
    }
  }
  for (const descriptor of GALLERY_BLOCKS) {
    if (!seen.has(descriptor.key)) {
      ordered.push(descriptor)
    }
  }
  return ordered
}

/** Move `key` one slot up (-1) or down (+1) within `keys`; bounds-safe, immutable. */
export const reorderGalleryKeys = (
  keys: readonly BlockTypeKey[],
  key: BlockTypeKey,
  direction: -1 | 1,
): BlockTypeKey[] => {
  const index = keys.indexOf(key)
  const target = index + direction
  if (index < 0 || target < 0 || target >= keys.length) {
    return [...keys]
  }
  const next = [...keys]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** Resolve the active profile's style for a block type (undefined when unstyled). */
export const getProfileBlockStyle = (
  profile: TypographyProfile | null | undefined,
  key: BlockTypeKey,
): BlockStyle | undefined => profile?.blocks?.[key]

/* -------------------------------------------------- active-style resolution */

/**
 * Direct map from the toolbar's `blockType` state (keys of `blockTypeToBlockName`
 * in ToolbarPlugin) to the gallery key that renders that real block type. `h6`
 * and any other unlisted type map to no square (null). `paragraph` is handled
 * separately (variant disambiguation) and is intentionally absent here.
 */
const BLOCK_TYPE_TO_GALLERY_KEY: Record<string, BlockTypeKey> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  quote: 'quote',
  code: 'code',
  bullet: 'bulletList',
  number: 'numberedList',
  check: 'checkList',
}

/**
 * The paragraph-variant keys checked most-specific-first when the active block is
 * a plain `paragraph`: the first whose effective (merged) style is a subset of
 * the block's stamped inline style wins; if none match it is plain Normal.
 */
const PARAGRAPH_VARIANT_PRIORITY: BlockTypeKey[] = ['title', 'accented', 'normalSpaced', 'strong', 'emphasis']

/**
 * Resolve which gallery square (if any) matches the current selection/cursor's
 * block, so the gallery can render it in an active state. Pure.
 *
 * - Real block types map directly from `blockType` (h1–h5, quote, code, lists;
 *   `h6` → null).
 * - A plain `paragraph` may be one of the inline-style-only variants; a variant
 *   is active when its effective style — the SAME `{ ...baseStyle,
 *   ...profileOverride }` merge stamped at apply time — is a subset of the
 *   block's current inline style string. Checked most-specific-first; if none
 *   match, the block is plain Normal (`'paragraph'`).
 *
 * Best-effort: `$applyBlockStyleEntries` merges (never clears) prior properties,
 * so switching styles can leave a stale signature on a block — detection returns
 * the most-specific still-matching variant. See the plan's flagged limitation.
 */
export const resolveActiveGalleryKey = (args: {
  blockType: string
  style: string
  profile: TypographyProfile | null | undefined
}): BlockTypeKey | null => {
  const { blockType, style, profile } = args

  if (blockType !== 'paragraph') {
    return BLOCK_TYPE_TO_GALLERY_KEY[blockType] ?? null
  }

  const parsed = parseStyleString(style)
  for (const key of PARAGRAPH_VARIANT_PRIORITY) {
    const descriptor = GALLERY_BLOCKS.find((d) => d.key === key)
    if (!descriptor?.baseStyle) {
      continue
    }
    const merged = { ...descriptor.baseStyle, ...(getProfileBlockStyle(profile, key) ?? {}) }
    const entries = blockStyleToStyleEntries(merged)
    if (entries.length > 0 && entries.every(([prop, value]) => parsed.get(prop) === value)) {
      return key
    }
  }
  return 'paragraph'
}

/* ----------------------------------------------------- responsive inline fit */

/**
 * Fixed geometry of an inline preview square, in CSS px. The width is a constant
 * (not measured) so the fit math below is pure and deterministic — the toolbar
 * bar renders each square at exactly this width, measures the available track,
 * and asks `computeGalleryFit` how many squares fit inline.
 */
export const GALLERY_SQUARE_WIDTH = 88
/** Horizontal gap between adjacent inline squares / the overflow toggle, in px. */
export const GALLERY_SQUARE_GAP = 6
/** Reserved track (toggle width + its leading gap) for the overflow "▾" button. */
export const GALLERY_OVERFLOW_TOGGLE_WIDTH = 34 + GALLERY_SQUARE_GAP

export type GalleryFit = {
  /** How many squares render inline in the bar. */
  inlineCount: number
  /** How many squares spill into the overflow "▾" dropdown. */
  overflowCount: number
}

/**
 * Given the available inline track `containerWidth` (px) and the number of
 * squares `total`, compute how many fit inline vs. overflow into the dropdown.
 *
 * A run of N squares occupies `N*squareWidth + (N-1)*gap`, so the most that fit
 * in a width W is `floor((W + gap) / (squareWidth + gap))`. When not all fit, we
 * reserve `overflowWidth` for the "▾" toggle and recompute, so the toggle itself
 * never causes horizontal overflow. Degrades to `{ inlineCount: 0, overflowCount:
 * total }` at very narrow widths (everything reachable via the dropdown). Pure.
 */
export function computeGalleryFit({
  containerWidth,
  total,
  squareWidth = GALLERY_SQUARE_WIDTH,
  gap = GALLERY_SQUARE_GAP,
  overflowWidth = GALLERY_OVERFLOW_TOGGLE_WIDTH,
}: {
  containerWidth: number
  total: number
  squareWidth?: number
  gap?: number
  overflowWidth?: number
}): GalleryFit {
  if (total <= 0) {
    return { inlineCount: 0, overflowCount: 0 }
  }
  const fitIn = (width: number): number =>
    width < squareWidth ? 0 : Math.max(0, Math.floor((width + gap) / (squareWidth + gap)))

  // Everything fits with room to spare → no overflow toggle needed.
  if (fitIn(containerWidth) >= total) {
    return { inlineCount: total, overflowCount: 0 }
  }
  // Otherwise reserve the toggle's width so it can't push the row over.
  const inlineCount = Math.min(fitIn(containerWidth - overflowWidth), total - 1)
  return { inlineCount: Math.max(0, inlineCount), overflowCount: total - Math.max(0, inlineCount) }
}

/**
 * Apply a gallery square to the current selection: first convert the block TYPE
 * (reusing the block op), then — if the active profile styles that block —
 * stamp its style as a per-block inline override that persists via #77. When the
 * profile has no style for the block, only the type is set.
 *
 * The two steps run as separate editor updates because the list block ops
 * dispatch their own commands; by the time the style update runs the selection
 * sits inside the freshly-created block(s), so the override lands on them.
 */
export const applyTypographyBlockToSelection = (
  editor: LexicalEditor,
  descriptor: GalleryBlockDescriptor,
  profile: TypographyProfile | null | undefined,
): void => {
  descriptor.setType(editor)

  // Effective style = built-in `baseStyle` (paragraph-variant identity) with the
  // active profile's override layered on top per property. Real block types have
  // no baseStyle, so this reduces to the profile style alone.
  const profileStyle = getProfileBlockStyle(profile, descriptor.key)
  const merged = { ...(descriptor.baseStyle ?? {}), ...(profileStyle ?? {}) }
  const entries = blockStyleToStyleEntries(merged)
  if (entries.length === 0) {
    return
  }

  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) {
      $applyBlockStyleEntries(selection, entries)
    }
  })
}
