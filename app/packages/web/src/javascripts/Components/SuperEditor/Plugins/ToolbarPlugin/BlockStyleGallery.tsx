/**
 * Standard Red Notes: Typography Profiles — Phase 2 gallery UI.
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
        'relative flex flex-shrink-0 select-none flex-col items-stretch gap-1 rounded border bg-default p-1.5',
        'transition-colors duration-75 hover:border-info hover:bg-contrast focus:outline-none focus-visible:border-info',
        isActive ? 'border-info ring-2 ring-info' : 'border-border',
      )}
      onClick={() => onApply(descriptor)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Active affordance: a small check badge in the top-right corner. */}
      {isActive && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-info text-info-contrast shadow-sm"
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
          className="flex origin-left items-center whitespace-nowrap leading-snug"
          style={{ transform: `scale(${previewScale})` }}
        >
          <BlockStylePreview descriptor={descriptor} style={inlineStyle} />
        </div>
      </div>
      <span className="flex items-center gap-1 overflow-hidden">
        <Icon type={descriptor.iconName} size="custom" className="h-3.5 w-3.5 flex-shrink-0 text-passive-1" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.65rem] leading-none text-passive-0">
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
  activeKey,
}: {
  descriptors: GalleryBlockDescriptor[]
  profile: TypographyProfile | null | undefined
  onApply: (descriptor: GalleryBlockDescriptor) => void
  /** The resolved active gallery key, so the toggle can signal a hidden active style. */
  activeKey?: string | null
}) => {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  // When the active style is one of the collapsed squares, signal it on the "▾"
  // toggle so the user still sees that a style is in use even while hidden.
  const hasActive = activeKey != null && descriptors.some((d) => d.key === activeKey)
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
          'relative flex h-full flex-shrink-0 items-center justify-center gap-0.5 rounded border bg-default px-1.5',
          'text-xs text-passive-0 transition-colors duration-75 hover:border-info hover:bg-contrast focus:outline-none focus-visible:border-info',
          hasActive || open ? 'border-info' : 'border-border',
          open ? 'bg-contrast' : '',
        )}
      >
        {hasActive && (
          <span aria-hidden className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-info shadow-sm" />
        )}
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
              isActive={descriptor.key === activeKey}
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
 * The responsive full-width squares track. Renders as many truthful preview
 * squares as fit the group width (measured via ResizeObserver) and collapses the
 * rest into an overflow "▾" dropdown, never causing horizontal overflow. This is
 * the squares row only; the block group's first-line action buttons (Smart
 * checklist, Restore completed tasks, Edit styles) are rendered by the caller
 * above it, NOT here.
 */
export const BlockStyleGalleryBar = ({
  profile,
  onApplyBlock,
  activeBlockType,
  activeBlockStyle,
}: {
  profile: TypographyProfile | null | undefined
  onApplyBlock: (descriptor: GalleryBlockDescriptor) => void
  /** The current selection/cursor's block TYPE (from the toolbar's blockType state). */
  activeBlockType?: string
  /** The current block's stamped inline style string (disambiguates paragraph variants). */
  activeBlockStyle?: string
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

  const total = GALLERY_BLOCKS.length
  const { inlineCount } = useMemo(
    () => computeGalleryFit({ containerWidth: trackWidth, total, overflowWidth: GALLERY_OVERFLOW_TOGGLE_WIDTH }),
    [trackWidth, total],
  )
  const inlineBlocks = GALLERY_BLOCKS.slice(0, inlineCount)
  const overflowBlocks = GALLERY_BLOCKS.slice(inlineCount)

  // Which square (if any) matches the current selection/cursor's block style.
  const activeKey = useMemo(
    () => resolveActiveGalleryKey({ blockType: activeBlockType ?? '', style: activeBlockStyle ?? '', profile }),
    [activeBlockType, activeBlockStyle, profile],
  )

  return (
    <div
      ref={trackRef}
      className="flex w-full min-w-0 items-stretch gap-1.5 overflow-hidden"
      onMouseDown={(event) => event.preventDefault()}
    >
      {inlineBlocks.map((descriptor) => (
        <BlockStyleSquare
          key={descriptor.key}
          descriptor={descriptor}
          profile={profile}
          isActive={descriptor.key === activeKey}
          onApply={onApplyBlock}
        />
      ))}
      {overflowBlocks.length > 0 && (
        <OverflowSquares descriptors={overflowBlocks} profile={profile} onApply={onApplyBlock} activeKey={activeKey} />
      )}
    </div>
  )
}

export default BlockStyleGalleryBar
