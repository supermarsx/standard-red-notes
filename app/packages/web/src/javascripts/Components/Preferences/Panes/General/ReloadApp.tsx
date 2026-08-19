import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ButtonType } from '@standardnotes/snjs'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Button from '@/Components/Button/Button'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { useApplication } from '@/Components/ApplicationProvider'
import { reloadApplicationClearingCaches } from '@/Utils/AppCacheReset'

/**
 * Standard Red Notes: "Reload app and clear cached files".
 *
 * Recovers a browser that is stuck on program files from a previous release —
 * a service worker shell cache that outlived its deploy, or (as happened in
 * production) one poisoned with a reverse-proxy error page during an outage.
 * The service worker evicts old caches on activate by itself; this is the
 * manual escape hatch for when it cannot, e.g. the poisoned entry belongs to
 * the CURRENT cache name.
 *
 * It clears CACHED PROGRAM FILES ONLY. See Utils/AppCacheReset for the storage
 * boundary — notes, files, keys, the session and unsynced writes live in
 * IndexedDB/localStorage and are never touched, which is why the copy below can
 * promise that plainly. Users must not be scared away from a safe action, and
 * must not be misled into a destructive one.
 */
const ReloadApp: FunctionComponent = () => {
  const application = useApplication()

  const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  const [isReloading, setIsReloading] = useState(false)

  useEffect(() => {
    const update = () => setIsOffline(navigator.onLine === false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const reload = useCallback(async () => {
    // Offline is a warn-and-let-them-choose, not a block. Clearing the shell
    // while offline can leave the app unable to boot until connectivity
    // returns (there is no cached copy left to fall back to), but a user whose
    // app is broken by a bad cache may have no other route back — and refusing
    // outright would make the control useless in exactly the case it exists
    // for. So the offline consequence is stated in the confirmation itself.
    const offlineWarning = isOffline
      ? '\n\nYou appear to be offline. The app may not load again until you reconnect, because the offline copy is what is being cleared.'
      : ''

    const confirmed = await application.alerts.confirm(
      'This clears the cached program files (app scripts, styles, fonts) and restarts the app so it re-downloads them.' +
        '\n\nYour notes, files, account and any unsynced changes are stored separately and are NOT affected.' +
        offlineWarning,
      'Reload app and clear cached files?',
      'Reload app',
      isOffline ? ButtonType.Danger : ButtonType.Info,
    )

    if (!confirmed) {
      return
    }

    setIsReloading(true)

    try {
      await reloadApplicationClearingCaches()
    } catch (error) {
      setIsReloading(false)
      void application.alerts.alert(
        `Couldn't clear the cached files: ${error instanceof Error ? error.message : String(error)}`,
        'Reload failed',
      )
    }
  }, [application, isOffline])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Reload app</Title>
        <Subtitle>Clear cached program files and restart the app</Subtitle>

        <Text className="mt-2">
          The app keeps a copy of its own program files (scripts, styles, fonts) so it can open while you&apos;re
          offline. If a release left a stale or broken copy behind, this discards it and re-downloads a fresh one.
        </Text>
        <Text className="mt-2">
          <span className="font-bold">Your notes and account are not affected.</span> Notes, files, encryption keys,
          your session and any changes that haven&apos;t synced yet are stored separately from this cache and are left
          untouched. You will not be signed out.
        </Text>

        {isOffline && (
          // The wrapper carries the hook: <Text> renders only children+className
          // and drops any other prop, so the attribute must live outside it.
          <div data-test="reload-app-offline-warning">
            <Text className="text-warning mt-2">
              You appear to be offline. Clearing the cache now means the app may not load again until you reconnect.
            </Text>
          </div>
        )}

        <div className="mt-3">
          <Button
            label={isReloading ? 'Reloading…' : 'Reload app and clear cached files'}
            disabled={isReloading}
            onClick={reload}
          />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(ReloadApp)
