import { FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'
import { useApplication } from '@/Components/ApplicationProvider'
import { initialsForUser } from './avatarCore'
import { useStoredAvatar } from './useStoredAvatar'

type Props = {
  /** Email (or name) the initials fallback is derived from. */
  email?: string | null
  /** Pixel diameter of the circular avatar. */
  size?: number
  className?: string
}

/**
 * Reusable circular avatar. Renders, in priority order:
 *  1. the locally-stored profile picture (kept live via {@link useStoredAvatar}),
 *  2. the user's initials derived from their email, or
 *  3. the existing account icon when there's no email to derive initials from.
 *
 * Theme-consistent: uses the app's `info`/`default` palette and inherits sizing
 * from the `size` prop so it fits both the compact footer button and the larger
 * Account-pane preview.
 */
const Avatar: FunctionComponent<Props> = ({ email, size = 24, className }) => {
  const application = useApplication()
  const avatar = useStoredAvatar(application)
  const dimension = { width: size, height: size }

  const wrapperClasses = classNames(
    'flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full',
    className,
  )

  if (avatar) {
    return (
      <span className={wrapperClasses} style={dimension}>
        <img src={avatar} alt="Profile picture" className="h-full w-full object-cover" style={dimension} />
      </span>
    )
  }

  const initials = initialsForUser(email)

  if (initials !== '?') {
    return (
      <span
        className={classNames(wrapperClasses, 'bg-info font-semibold uppercase text-info-contrast')}
        style={{ ...dimension, fontSize: Math.max(10, Math.round(size * 0.42)) }}
        aria-label="Profile initials"
      >
        {initials}
      </span>
    )
  }

  return (
    <span className={classNames(wrapperClasses, 'bg-default text-neutral')} style={dimension}>
      <Icon type="account-circle" size="custom" className="h-full w-full" />
    </span>
  )
}

export default Avatar
