import { SuperEditorContentId } from '../../Constants'

/**
 * Shared types + helpers for the Word-style image tools added to the Super
 * (Lexical) editor. These attributes are persisted on the image nodes
 * (FileNode / RemoteImageNode / InlineFileNode) and round-trip through their
 * exportJSON / importJSON.
 *
 * IMPORTANT — text-wrap limitation:
 * All three image nodes extend Lexical's `DecoratorBlockNode`, whose
 * `isInline()` returns `false`. That means every image occupies its own block
 * and the following paragraphs are *separate* sibling blocks. Lexical's block
 * model therefore cannot make body text flow *around* an image the way Word
 * does — a floated decorator block does not pull the next paragraph up beside
 * it. What we CAN do (and do) is float the image to the left/right *within its
 * own block* via CSS margins, so it sits to one side with whitespace beside it.
 * This is the honest, feasible subset of "text wrap"; full wrap would require
 * turning the image into an inline node and re-architecting how Super stores
 * images, which is out of scope for this web-only change.
 */

export type ImageFloat = 'none' | 'left' | 'right'

/**
 * Size presets expressed as a fraction of the editor content column width.
 * "Full width" clamps to the column so the image never causes horizontal
 * scroll.
 */
export type ImageSizePreset = 'small' | 'medium' | 'large' | 'full'

export const ImageSizePresetFractions: Record<ImageSizePreset, number> = {
  small: 0.25,
  medium: 0.5,
  large: 0.75,
  full: 1,
}

export const ImageSizePresetLabels: Record<ImageSizePreset, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  full: 'Full width',
}

/** Smallest width (px) a resized image is allowed to shrink to. */
export const MinImageWidth = 40

/**
 * Returns the usable content width (px) of the Super editor column, used to
 * clamp image widths so they can never exceed the column / cause horizontal
 * scroll. Falls back to a sane default when the editor element isn't mounted
 * (e.g. headless tests).
 */
export function getEditorContentWidth(fallback = 700): number {
  if (typeof document === 'undefined') {
    return fallback
  }
  const editorRoot = document.getElementById(SuperEditorContentId)
  if (!editorRoot) {
    return fallback
  }
  const style = window.getComputedStyle(editorRoot)
  const paddingLeft = parseFloat(style.paddingLeft) || 0
  const paddingRight = parseFloat(style.paddingRight) || 0
  const inner = editorRoot.clientWidth - paddingLeft - paddingRight
  return inner > MinImageWidth ? inner : fallback
}

/** Clamp a desired width to [MinImageWidth, editor content width]. */
export function clampImageWidth(width: number, maxWidth = getEditorContentWidth()): number {
  if (Number.isNaN(width)) {
    return MinImageWidth
  }
  return Math.max(MinImageWidth, Math.min(Math.round(width), Math.round(maxWidth)))
}

/** Compute the px width for a size preset, clamped to the editor column. */
export function widthForPreset(preset: ImageSizePreset): number {
  const contentWidth = getEditorContentWidth()
  return clampImageWidth(contentWidth * ImageSizePresetFractions[preset], contentWidth)
}
