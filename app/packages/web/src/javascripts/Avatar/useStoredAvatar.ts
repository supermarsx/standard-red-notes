import { useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { AvatarChangedEvent, getStoredAvatar } from './avatarService'

/**
 * React hook returning the locally-stored avatar data URL (or null), kept live:
 * it re-reads whenever {@link AvatarChangedEvent} fires (i.e. when the user sets
 * or removes their photo), so every surface using the Avatar component updates
 * the instant the photo changes.
 */
export function useStoredAvatar(application: WebApplication): string | null {
  const [avatar, setAvatar] = useState<string | null>(() => getStoredAvatar(application))

  useEffect(() => {
    const refresh = () => setAvatar(getStoredAvatar(application))
    refresh()
    window.addEventListener(AvatarChangedEvent, refresh)
    return () => window.removeEventListener(AvatarChangedEvent, refresh)
  }, [application])

  return avatar
}
