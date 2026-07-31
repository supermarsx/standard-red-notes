/**
 * Standard Red Notes: Typography Profiles gallery UI.
 *
 * "Nice little squares", each a static, non-editable, TRUTHFUL preview of a block
 * type as rendered by the ACTIVE typography profile: the block's real Lexical
 * theme class (base appearance) with the profile's style for that block layered
 * on as an inline override — exactly how a per-block override wins in the real
 * editor. Clicking a square applies it to the current selection (block type +
 * per-block style); see `typographyGallery.ts`.
 *
 * `BlockStyleGalleryBar` renders the squares row that occupies the 2nd and 3rd
 * lines of the block group. It is a pure, full-width squares track: it fills the
 * group width (measured with a ResizeObserver), showing as many squares as fit
 * and collapsing the rest into an overflow "▾" dropdown so it never causes
 * horizontal overflow. Each square is two text-lines tall. The block group's
 * first-line action buttons (Smart checklist, Restore completed tasks, Edit
 * styles) are rendered by the caller ABOVE this bar, not inside it.
 */
import { CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TypographyProfile } from '@standardnotes/models'
import { classNames } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { blockStyleToInlineStyle } from '@/Utils/typographyProfiles'
import {
  GALLERY_BLOCKS,
  GALLERY_LEADING_INDICATOR_WIDTH,
  GALLERY_OVERFLOW_TOGGLE_WIDTH,
  GALLERY_SQUARE_WIDTH,
  GalleryBlockDescriptor,
  computeGalleryFit,
  getProfileBlockStyle,
  resolveActiveGalleryKey,
} from './typographyGallery'

/**
 * The sample block element for a square, carrying the real theme class plus the
 * profile's inline style. Reusable in isolation (e.g. the P3 modal preview).
 */
export const BlockStylePreview = ({
  descriptor,
  style,
}: {
  descriptor: GalleryBlockDescriptor
  style: CSSProperties
}) => {
  const className = descriptor.themeClass
  switch (descriptor.kind) {
    case 'ul':
      return (
        <ul className={className} style={{ ...style, listStylePosition: 'inside', margin: 0, paddingLeft: 0 }}>
          <li className="Lexical__listItem">{descriptor.sample}</li>
        </ul>
      )
    case 'ol':
      return (
        <ol className={className} style={{ ...style, listStylePosition: 'inside', margin: 0, paddingLeft: 0 }}>
          <li className="Lexical__listItem">{descriptor.sample}</li>
        </ol>
      )
    case 'checklist':
      return (
        <ul className={className} style={{ ...style, margin: 0, paddingLeft: 0 }}>
          <li className="Lexical__listItem Lexical__listItemUnchecked">{descriptor.sample}</li>
        </ul>
      )
    default:
      return (
        <div className={className} style={style}>
          {descriptor.sample}
        </div>
      )
  }
}

/**
 * A single clickable preview square: a TWO-LINE-tall mini-preview above its
 * icon + label. Fixed width so the bar's fit math (typographyGallery) is exact.
 */
const BlockStyleSquare = ({
  descriptor,
  profile,
  onApply,
  isActive = false,
}: {
  descriptor: GalleryBlockDescriptor
  profile: TypographyProfile | null | undefined
  onApply: (descriptor: GalleryBlockDescriptor) => void
  /** True when this square matches the current selection/cursor's block style. */
  isActive?: boolean
}) => {
  // Effective preview style = built-in `baseStyle` (paragraph-variant identity)
  // with the active profile's override on top — the SAME merge used at apply time,
  // so the square is a truthful render of what clicking it produces.
  const profileStyle = getProfileBlockStyle(profile, descriptor.key)
  const merged = { ...(descriptor.baseStyle ?? {}), ...(profileStyle ?? {}) }
  const inlineStyle = blockStyleToInlineStyle(merged) as CSSProperties
  const mergedKey = JSON.stringify(merged)

  const previewBoxRef = useRef<HTMLDivElement>(null)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const [previewScale, setPreviewScale] = useState(1)

  useLayoutEffect(() => {
    const box = previewBoxRef.current
    const content = previewContentRef.current
    if (!box || !content) {
      return
    }
    const fit = () => {
      // scrollWidth/Height are the UN-transformed natural size (transform is
      // paint-only), so measuring is stable and never oscillates.
      const naturalWidth = content.scrollWidth
      const naturalHeight = content.scrollHeight
      if (!naturalWidth || !naturalHeight) {
        setPreviewScale(1)
        return
      }
      setPreviewScale(Math.min(1, box.clientWidth / naturalWidth, box.clientHeight / naturalHeight))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [descriptor.key, mergedKey])

  return (
    <button
      type="button"
      title={descriptor.label}
      aria-label={descriptor.label}
      aria-pressed={isActive}
      style={{ width: GALLERY_SQUARE_WIDTH }}
      className={classNames(
        'bg-default relative flex flex-shrink-0 flex-col items-stretch gap-1 rounded border p-1.5 select-none',
        'hover:border-info hover:bg-contrast focus-visible:border-info transition-colors duration-75 focus:outline-none',
        isActive ? 'border-info ring-info ring-2' : 'border-border',
      )}
      onClick={() => onApply(descriptor)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Active affordance: a small check badge in the top-right corner. */}
      {isActive && (
        <span
          aria-hidden
          className="bg-info text-info-contrast absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full shadow-sm"
        >
          <Icon type="check" size="custom" className="h-3 w-3" />
        </span>
      )}
      {/* Truthful mini-preview on the real editor surface colours. The sample is
          laid out on ONE natural-width line and scaled down (never up) via a
          measured `transform: scale()` so the whole styled sample stays visible
          inside the box — headings/large fonts shrink to fit instead of clipping. */}
      <div
        ref={previewBoxRef}
        className="flex h-[2.9rem] items-center justify-start overflow-hidden rounded-sm px-1.5"
        style={{
          backgroundColor: 'var(--sn-stylekit-editor-background-color)',
          color: 'var(--sn-stylekit-editor-foreground-color)',
        }}
      >
        <div
          ref={previewContentRef}
          className="flex origin-left items-center leading-snug whitespace-nowrap"
          style={{ transform: `scale(${previewScale})` }}
        >
          <BlockStylePreview descriptor={descriptor} style={inlineStyle} />
        </div>
      </div>
      <span className="flex items-center gap-1 overflow-hidden">
        <Icon type={descriptor.iconName} size="custom" className="text-passive-1 h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-passive-0 overflow-hidden text-[0.65rem] leading-none text-ellipsis whitespace-nowrap">
          {descriptor.label}
        </span>
      </span>
    </button>
  )
}

/** Overflow "▾" toggle + its dropdown of the squares that didn't fit inline. */
const OverflowSquares = ({
  descriptors,
  profile,
  onApply,
}: {
  descriptors: GalleryBlockDescriptor[]
  profile: TypographyProfile | null | undefined
  onApply: (descriptor: GalleryBlockDescriptor) => void
}) => {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title={`${descriptors.length} more block styles`}
        aria-label={`${descriptors.length} more block styles`}
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(event) => event.preventDefault()}
        className={classNames(
          'bg-default relative flex h-full flex-shrink-0 items-center justify-center gap-0.5 rounded border px-1.5',
          'text-passive-0 hover:border-info hover:bg-contrast focus-visible:border-info text-xs transition-colors duration-75 focus:outline-none',
          open ? 'border-info' : 'border-border',
          open ? 'bg-contrast' : '',
        )}
      >
        <span className="tabular-nums">{descriptors.length}</span>
        <Icon type="chevron-down" size="custom" className="h-3.5 w-3.5" />
      </button>
      <Popover
        title="More block styles"
        anchorElement={anchorRef}
        open={open}
        togglePopover={() => setOpen((o) => !o)}
        side="bottom"
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
      >
        <div className="grid grid-cols-3 gap-1.5 p-2" onMouseDown={(event) => event.preventDefault()}>
          {descriptors.map((descriptor) => (
            <BlockStyleSquare
              key={descriptor.key}
              descriptor={descriptor}
              profile={profile}
              onApply={(d) => {
                onApply(d)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </Popover>
    </>
  )
}

/**
 * The neutral leading slot shown when the active block has NO gallery
 * representation (h6, tables, images, dividers, decorator blocks — where
 * `resolveActiveGalleryKey` returns null). A muted, NON-interactive `div` of the
 * same width as a square so the row budget stays constant, showing an em-dash and
 * the caption "None". Deliberately NOT a `BlockStyleSquare` and NOT a `<button>`:
 * it carries no descriptor `title` (so it is uncounted by the specs' titled-button
 * filter), no active ring/check, and no `scale()` preview wrapper. It never shows
 * "Normal" — that would misrepresent a table/h6/image as a paragraph.
 */
const LeadingActivePlaceholder = () => (
  <div
    aria-hidden
    style={{ width: GALLERY_SQUARE_WIDTH }}
    className="border-border bg-default flex flex-shrink-0 flex-col items-stretch gap-1 rounded border border-dashed p-1.5 opacity-60 select-none"
  >
    <div className="text-passive-1 flex h-[2.9rem] items-center justify-center overflow-hidden rounded-sm px-1.5">
      <span className="text-lg leading-none">—</span>
    </div>
    <span className="flex items-center justify-center overflow-hidden">
      <span className="text-passive-1 overflow-hidden text-[0.65rem] leading-none text-ellipsis whitespace-nowrap">
        None
      </span>
    </span>
  </div>
)

/**
 * The responsive full-width squares track. It opens with a persistent LEADING
 * "current style" indicator (a truthful preview of the active style, or a neutral
 * "None" placeholder when the block has no gallery representation) and a thin
 * divider, then renders as many truthful preview squares as fit the remaining
 * group width (measured via ResizeObserver) and collapses the rest into an
 * overflow "▾" dropdown, never causing horizontal overflow. This is the squares
 * row only; the block group's first-line action buttons (Smart checklist, Restore
 * completed tasks, Edit styles) are rendered by the caller above it, NOT here.
 */
export const BlockStyleGalleryBar = ({
  profile,
  onApplyBlock,
  activeBlockType,
  activeBlockStyle,
  blocks = GALLERY_BLOCKS,
}: {
  profile: TypographyProfile | null | undefined
  onApplyBlock: (descriptor: GalleryBlockDescriptor) => void
  /** The current selection/cursor's block TYPE (from the toolbar's blockType state). */
  activeBlockType?: string
  /** The current block's stamped inline style string (disambiguates paragraph variants). */
  activeBlockStyle?: string
  /** The gallery descriptors, in display order. Defaults to the built-in default order. */
  blocks?: GalleryBlockDescriptor[]
}) => {
  // The full-width track the squares live in; its width drives the fit math.
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(0)

  useEffect(() => {
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((entries) => {
      setTrackWidth(entries[0]?.contentRect.width ?? el.clientWidth)
    })
    observer.observe(el)
    setTrackWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  // Which square (if any) matches the current selection/cursor's block style.
  const activeKey = useMemo(
    () => resolveActiveGalleryKey({ blockType: activeBlockType ?? '', style: activeBlockStyle ?? '', profile }),
    [activeBlockType, activeBlockStyle, profile],
  )
  // The descriptor for the leading "you are here" indicator: the active style's
  // own descriptor when it maps to a gallery square, else null → neutral "None"
  // placeholder. Derived each render, so the leading square tracks the selection live.
  const activeDescriptor = useMemo(
    () => (activeKey != null ? (blocks.find((d) => d.key === activeKey) ?? null) : null),
    [activeKey, blocks],
  )
  // The active style is shown ONCE, in the persistent leading indicator, so drop
  // its square from the sortable track — otherwise it appears twice ("Normal and
  // Normal"). The track carries only the NON-active styles. When the active block
  // has no gallery square (leading shows the "None" placeholder), nothing is removed.
  const trackBlocks = useMemo(
    () => (activeDescriptor ? blocks.filter((d) => d.key !== activeDescriptor.key) : blocks),
    [blocks, activeDescriptor],
  )

  const total = trackBlocks.length
  // The persistent leading indicator + its divider consume a fixed slice of the
  // front of the row, so the sortable track fits into the remaining width. The
  // leftover sub-track has no leading gap of its own, which is exactly what
  // `computeGalleryFit` assumes — so it is reused unchanged.
  const availableWidth = Math.max(0, trackWidth - GALLERY_LEADING_INDICATOR_WIDTH)
  const { inlineCount } = useMemo(
    () => computeGalleryFit({ containerWidth: availableWidth, total, overflowWidth: GALLERY_OVERFLOW_TOGGLE_WIDTH }),
    [availableWidth, total],
  )
  const inlineBlocks = trackBlocks.slice(0, inlineCount)
  const overflowBlocks = trackBlocks.slice(inlineCount)

  return (
    <div
      ref={trackRef}
      className="flex w-full min-w-0 items-stretch gap-1.5 overflow-hidden"
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Persistent LEADING "current style" indicator: the SOLE copy of the active
          style, shown up front ("you are here") so it stays visible as the selection
          moves. The sortable track excludes it (see `trackBlocks`) to avoid showing
          the same style twice. Clicking re-applies the active descriptor (idempotent).
          No gallery match → the neutral, non-interactive "None" placeholder. */}
      {activeDescriptor ? (
        <BlockStyleSquare descriptor={activeDescriptor} profile={profile} isActive onApply={onApplyBlock} />
      ) : (
        <LeadingActivePlaceholder />
      )}
      <span aria-hidden className="bg-border w-px flex-shrink-0 self-stretch" />
      {inlineBlocks.map((descriptor) => (
        <BlockStyleSquare key={descriptor.key} descriptor={descriptor} profile={profile} onApply={onApplyBlock} />
      ))}
      {overflowBlocks.length > 0 && (
        <OverflowSquares descriptors={overflowBlocks} profile={profile} onApply={onApplyBlock} />
      )}
    </div>
  )
}

export default BlockStyleGalleryBar
