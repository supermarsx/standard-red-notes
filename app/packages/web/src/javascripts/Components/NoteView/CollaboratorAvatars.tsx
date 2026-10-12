import { CSSProperties, FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import { Collaborator, MAX_BAR_AVATARS } from './collaborators'

type AvatarProps = {
  collaborator: Collaborator
  /** `bar` is sized to the title bar's 20px status chips; `list` to a popup row. */
  size: 'bar' | 'list'
  className?: string
  style?: CSSProperties
}

/**
 * One collaborator as a disc of initials in their own cursor colour.
 *
 * Always decorative: the name is carried by whatever the avatar sits in (the
 * trigger's accessible name, or the row's text), so a screen reader is never
 * handed bare initials.
 */
export const CollaboratorAvatar: FunctionComponent<AvatarProps> = ({ collaborator, size, className, style }) => {
  return (
    <span
      aria-hidden
      className={classNames(
        'relative flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white select-none',
        size === 'bar' ? 'h-5 w-5 text-[0.55rem]' : 'h-6 w-6 text-[0.6rem]',
        className,
      )}
      data-collaborator-avatar={collaborator.key}
      style={{ backgroundColor: collaborator.color, ...style }}
    >
      {collaborator.initials}
      {collaborator.presence === 'typing' && (
        // The dot IS the cue, so it reads with motion off; the pulse is only added where motion is welcome.
        <span
          className="bg-success ring-default absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 motion-safe:animate-pulse"
          data-collaborator-typing
        />
      )}
    </span>
  )
}

type StackProps = {
  /** The collaborators who are in the note right now, most active first. */
  present: Collaborator[]
  /** A dropped connection: these were here a moment ago and may not be now. */
  dimmed: boolean
}

/**
 * The title bar's cluster: overlapping avatars, then "+N" for everyone past the
 * cap. It is exactly as tall as the status chip beside it — the separating ring
 * is a box-shadow, which takes no room — so it can never grow the bar.
 *
 * The trigger renders it only at `md` and up, and only while not collapsed;
 * otherwise it shows the count instead.
 */
export const CollaboratorAvatarStack: FunctionComponent<StackProps> = ({ present, dimmed }) => {
  const shown = present.slice(0, MAX_BAR_AVATARS)
  const overflow = present.length - shown.length

  return (
    <span
      aria-hidden
      className={classNames('isolate ml-1 flex items-center -space-x-1.5', dimmed && 'opacity-60')}
      data-collaborator-avatars
    >
      {shown.map((collaborator, index) => (
        <CollaboratorAvatar
          className="ring-default ring-2"
          collaborator={collaborator}
          key={collaborator.key}
          size="bar"
          // Earlier avatars sit on top, so a typing dot is never buried under the next disc.
          style={{ zIndex: shown.length - index }}
        />
      ))}
      {overflow > 0 && (
        <span
          className="bg-contrast text-text ring-default relative flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold ring-2 select-none"
          data-collaborator-overflow
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}
