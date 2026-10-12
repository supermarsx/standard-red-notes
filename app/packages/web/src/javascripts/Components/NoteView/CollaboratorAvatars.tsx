import { CSSProperties, FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import { Collaborator, MAX_BAR_AVATARS } from './collaborators'

type AvatarProps = {
  collaborator: Collaborator
  /**
   * `bar` is sized to the title bar's 20px status chips and shows ONE initial:
   * the discs overlap there, and two letters lose an edge to the disc on top.
   * `list` is a popup row's disc, with both.
   */
  size: 'bar' | 'list'
  className?: string
  style?: CSSProperties
}

/**
 * One collaborator as a disc of initials in their own cursor colour.
 *
 * Someone who is only reconnecting keeps their place but loses their colour: a
 * collaborator's connection dropping and coming back is routine, and a disc that
 * vanished and reappeared each time would be noise about the transport. It is
 * drained with a filter rather than made translucent, because the discs in the
 * title bar overlap and a translucent one shows its neighbour through itself.
 *
 * Always decorative: the name is carried by whatever the avatar sits in (the
 * trigger's accessible name, or the row's text), so a screen reader is never
 * handed bare initials.
 */
export const CollaboratorAvatar: FunctionComponent<AvatarProps> = ({ collaborator, size, className, style }) => {
  const reconnecting = collaborator.presence === 'reconnecting'
  return (
    <span
      aria-hidden
      className={classNames(
        'relative flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white select-none',
        size === 'bar' ? 'h-5 w-5 text-[0.65rem]' : 'h-6 w-6 text-[0.6rem]',
        reconnecting && 'grayscale',
        className,
      )}
      data-collaborator-avatar={collaborator.key}
      data-collaborator-reconnecting={reconnecting ? '' : undefined}
      style={{ backgroundColor: collaborator.color, ...style }}
    >
      {size === 'bar' ? Array.from(collaborator.initials)[0] : collaborator.initials}
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
  /** The collaborators the registry lists for this note, most active first. */
  present: Collaborator[]
}

/**
 * The title bar's cluster: overlapping avatars, then "+N" for everyone past the
 * cap. It is exactly as tall as the status chip beside it — the separating ring
 * is a box-shadow, which takes no room — so it can never grow the bar.
 *
 * The trigger renders it only at `md` and up, and only while not collapsed;
 * otherwise it shows the count instead.
 */
export const CollaboratorAvatarStack: FunctionComponent<StackProps> = ({ present }) => {
  const shown = present.slice(0, MAX_BAR_AVATARS)
  const overflow = present.length - shown.length

  return (
    <span aria-hidden className="isolate ml-1 flex items-center -space-x-1" data-collaborator-avatars>
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
        // Padded on the left by what the last disc and its ring cover, so the "+" is never under them.
        <span
          className="bg-contrast text-text ring-default relative flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full pr-1 pl-2 text-[0.6rem] font-bold ring-2 select-none"
          data-collaborator-overflow
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}
