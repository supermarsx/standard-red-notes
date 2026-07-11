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
import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
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
}: {
  descriptor: GalleryBlockDescriptor
  profile: TypographyProfile | null | undefined
  onApply: (descriptor: GalleryBlockDescriptor) => void
}) => {
  const blockStyle = getProfileBlockStyle(profile, descriptor.key)
  const inlineStyle = (blockStyle ? blockStyleToInlineStyle(blockStyle) : {}) as CSSProperties

  return (
    <button
      type="button"
      title={descriptor.label}
      aria-label={descriptor.label}
      style={{ width: GALLERY_SQUARE_WIDTH }}
      className={classNames(
        'flex flex-shrink-0 select-none flex-col items-stretch gap-1 rounded border border-border bg-default p-1.5',
        'transition-colors duration-75 hover:border-info hover:bg-contrast focus:outline-none focus-visible:border-info',
      )}
      onClick={() => onApply(descriptor)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Truthful mini-preview on the real editor surface colours. Two text-lines
          tall and clipped, so a large heading fits while its relative size shows.
          `leading-snug` + wrapping lets normal text flow onto a second line. */}
      <div
        className="flex h-[2.9rem] items-center justify-start overflow-hidden rounded-sm px-1.5 leading-snug"
        style={{
          backgroundColor: 'var(--sn-stylekit-editor-background-color)',
          color: 'var(--sn-stylekit-editor-foreground-color)',
        }}
      >
        <BlockStylePreview descriptor={descriptor} style={inlineStyle} />
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
          'flex h-full flex-shrink-0 items-center justify-center gap-0.5 rounded border border-border bg-default px-1.5',
          'text-xs text-passive-0 transition-colors duration-75 hover:border-info hover:bg-contrast focus:outline-none focus-visible:border-info',
          open ? 'border-info bg-contrast' : '',
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
}: {
  profile: TypographyProfile | null | undefined
  onApplyBlock: (descriptor: GalleryBlockDescriptor) => void
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

  return (
    <div
      ref={trackRef}
      className="flex w-full min-w-0 items-stretch gap-1.5 overflow-hidden"
      onMouseDown={(event) => event.preventDefault()}
    >
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
