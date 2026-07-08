/**
 * Standard Red Notes: Typography Profiles — Phase 2 gallery UI.
 *
 * A grid of "nice little squares", each a static, non-editable, TRUTHFUL preview
 * of a block type as rendered by the ACTIVE typography profile: the block's real
 * Lexical theme class (base appearance) with the profile's style for that block
 * layered on as an inline override — exactly how a per-block override wins in the
 * real editor. Clicking a square applies it to the current selection (block type
 * + per-block style); see `typographyGallery.ts`.
 */
import { CSSProperties } from 'react'
import type { TypographyProfile } from '@standardnotes/models'
import { classNames } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import { blockStyleToInlineStyle } from '@/Utils/typographyProfiles'
import { GALLERY_BLOCKS, GalleryBlockDescriptor, getProfileBlockStyle } from './typographyGallery'

/**
 * The sample block element for a square, carrying the real theme class plus the
 * profile's inline style. Reusable in isolation (e.g. future settings preview).
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
 * A single clickable preview square: the mini-preview above its icon + label.
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
      className={classNames(
        'flex select-none flex-col items-stretch gap-1 rounded border border-border bg-default p-1.5',
        'transition-colors duration-75 hover:border-info hover:bg-contrast focus:outline-none focus-visible:border-info',
      )}
      onClick={() => onApply(descriptor)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Truthful mini-preview on the real editor surface colours. Clipped to a
          fixed box so a large heading still fits while its relative size shows. */}
      <div
        className="flex h-11 items-center overflow-hidden rounded-sm px-1.5"
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

/**
 * The gallery grid. Reads the resolved active profile and renders one square per
 * gallery block; clicking a square invokes `onApplyBlock`.
 */
const BlockStyleGallery = ({
  profile,
  onApplyBlock,
  onEditStyles,
}: {
  profile: TypographyProfile | null | undefined
  onApplyBlock: (descriptor: GalleryBlockDescriptor) => void
  /** Optional: open the Phase 3 popup style editor for the active profile. */
  onEditStyles?: () => void
}) => {
  return (
    <div className="flex flex-col gap-2 p-2" onMouseDown={(event) => event.preventDefault()}>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs text-passive-1">
          {profile ? profile.name : 'Default'} · click a style to apply it to the current block
        </span>
        {onEditStyles ? (
          <button
            type="button"
            onClick={onEditStyles}
            className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-info hover:bg-contrast focus:outline-none focus-visible:bg-contrast"
          >
            <Icon type="pencil-filled" size="custom" className="h-3.5 w-3.5" />
            Edit styles…
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {GALLERY_BLOCKS.map((descriptor) => (
          <BlockStyleSquare key={descriptor.key} descriptor={descriptor} profile={profile} onApply={onApplyBlock} />
        ))}
      </div>
    </div>
  )
}

export default BlockStyleGallery
