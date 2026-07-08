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
import { $applyBlockStyleEntries } from './blockFormatting'
import { ParagraphBlock } from '../Blocks/Paragraph'
import { H1Block, H2Block, H3Block } from '../Blocks/Headings'
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
    sample: 'Normal text',
    setType: (editor) => ParagraphBlock.onSelect(editor),
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
    key: 'quote',
    label: 'Quote',
    iconName: 'quote',
    themeClass: 'Lexical__quote',
    kind: 'block',
    sample: 'Quote',
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
    sample: 'Bulleted',
    setType: (editor) => BulletedListBlock.onSelect(editor),
  },
  {
    key: 'numberedList',
    label: 'Numbered',
    iconName: 'list-numbered',
    themeClass: 'Lexical__ol1',
    kind: 'ol',
    sample: 'Numbered',
    setType: (editor) => NumberedListBlock.onSelect(editor),
  },
  {
    key: 'checkList',
    label: 'Checklist',
    iconName: 'list-check',
    themeClass: 'Lexical__checkList',
    kind: 'checklist',
    sample: 'Checklist',
    setType: (editor) => ChecklistBlock.onSelect(editor),
  },
]

/** Resolve the active profile's style for a block type (undefined when unstyled). */
export const getProfileBlockStyle = (
  profile: TypographyProfile | null | undefined,
  key: BlockTypeKey,
): BlockStyle | undefined => profile?.blocks?.[key]

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

  const style = getProfileBlockStyle(profile, descriptor.key)
  if (!style) {
    return
  }
  const entries = blockStyleToStyleEntries(style)
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
