import { FunctionComponent, useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PrefKey, UpdateCheckIntervalValue } from '@standardnotes/snjs'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import usePreference from '@/Hooks/usePreference'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  readLastStatusSnapshot,
  UPDATE_CHECK_INTERVAL_OPTIONS,
  UpdateCheckSnapshot,
} from '@/Services/UpdateCheck/UpdateCheckService'

/**
 * Standard Red Notes: self-hosted "Check for updates".
 *
 * The server performs the actual check against its operator-configured
 * UPDATE_CHECK_URL; this pane shows the last known result, offers a manual
 * "Check for updates" (which bypasses the server's cache), and configures the
 * synced auto-check toggle + schedule. The auto-check toggle and the "Never"
 * schedule overlap deliberately — either disables automatic checks — and the
 * dropdown is disabled while the toggle is off to keep that coherent. The
 * last-checked time shown here is DEVICE-LOCAL: each device checks on its own
 * schedule.
 */
const Updates: FunctionComponent = () => {
  const application = useApplication()

  const autoEnabled = usePreference(PrefKey.UpdateCheckAutoEnabled)
  const interval = usePreference(PrefKey.UpdateCheckInterval)
  const showWhatsNew = usePreference(PrefKey.ShowWhatsNewSection)

  const [snapshot, setSnapshot] = useState<UpdateCheckSnapshot | undefined>(() => readLastStatusSnapshot())
  const [isChecking, setIsChecking] = useState(false)
  const [manualCheckFailed, setManualCheckFailed] = useState(false)

  const checkNow = useCallback(() => {
    setIsChecking(true)
    setManualCheckFailed(false)
    application.updateCheckService
      .check({ force: true })
      .then((result) => {
        if (result.ok) {
          setSnapshot(result.snapshot)
        } else {
          setManualCheckFailed(true)
        }
      })
      .catch(() => setManualCheckFailed(true))
      .finally(() => setIsChecking(false))
  }, [application])

  const toggleAutoCheck = useCallback(() => {
    void application.setPreference(PrefKey.UpdateCheckAutoEnabled, !autoEnabled)
  }, [application, autoEnabled])

  const toggleShowWhatsNew = useCallback(() => {
    void application.setPreference(PrefKey.ShowWhatsNewSection, !showWhatsNew)
  }, [application, showWhatsNew])

  const changeInterval = useCallback(
    (value: string) => {
      void application.setPreference(PrefKey.UpdateCheckInterval, value as UpdateCheckIntervalValue)
    },
    [application],
  )

  const intervalItems: DropdownItem[] = UPDATE_CHECK_INTERVAL_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }))

  const status = snapshot?.status

  const renderResult = () => {
    if (manualCheckFailed) {
      return <Text className="text-danger">Couldn&apos;t reach your server. Try again later.</Text>
    }
    if (!snapshot || !status) {
      return <Text>No update check has run on this device yet.</Text>
    }
    if (!status.configured) {
      return <Text>Update checks are not configured on this server (UPDATE_CHECK_URL is unset).</Text>
    }
    if (status.error === 'unreachable') {
      return <Text className="text-danger">The server couldn&apos;t reach the configured update source.</Text>
    }
    if (status.error === 'invalid-response') {
      return <Text className="text-danger">The configured update source returned an unrecognized response.</Text>
    }
    if (status.updateAvailable) {
      return (
        <Text>
          <span className="font-bold">Update available:</span> version {status.latestVersion}
          {status.releaseUrl && (
            <>
              {' — '}
              <a className="underline" href={status.releaseUrl} target="_blank" rel="noopener noreferrer">
                view release
              </a>
            </>
          )}
        </Text>
      )
    }
    return <Text>Up to date.</Text>
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Updates</Title>
        <Subtitle>Check whether a newer release of this self-hosted server is available</Subtitle>

        <Text className="mt-2">
          App version <span className="font-bold">{application.version}</span>
          {status?.currentVersion && (
            <>
              {' · '}Server version <span className="font-bold">{status.currentVersion}</span>
            </>
          )}
        </Text>

        <div className="mt-3">{renderResult()}</div>
        {snapshot && (
          <Text className="text-passive-1 mt-1">
            Last checked on this device: {new Date(snapshot.checkedAt).toLocaleString()}
          </Text>
        )}

        <div className="mt-3">
          <Button label={isChecking ? 'Checking…' : 'Check for updates'} onClick={checkNow} disabled={isChecking} />
        </div>

        <HorizontalSeparator classes="my-4" />

        <div className="flex justify-between gap-2 md:items-center">
          <div className="flex flex-col">
            <Subtitle>Check for updates automatically</Subtitle>
            <Text>
              Checks on this device on app start and periodically while the app is open, following the schedule below.
              Turning this off disables all automatic checks regardless of the schedule.
            </Text>
          </div>
          <Switch onChange={toggleAutoCheck} checked={autoEnabled} />
        </div>

        <div className="mt-3">
          <Subtitle>Schedule</Subtitle>
          <Text className="mb-2">
            How often this device checks automatically. &ldquo;Never&rdquo; has the same effect as turning the toggle
            off.
          </Text>
          <div className="max-w-xs">
            <Dropdown
              label="Select how often to check for updates automatically"
              items={intervalItems}
              value={interval}
              onChange={changeInterval}
              disabled={!autoEnabled}
            />
          </div>
        </div>

        <HorizontalSeparator classes="my-4" />

        <div className="flex justify-between gap-2 md:items-center">
          <div className="flex flex-col">
            <Subtitle>Show What&apos;s New in preferences</Subtitle>
            <Text>
              Show the What&apos;s New section (release notes) in the preferences menu. When hidden, its unread badge is
              hidden too.
            </Text>
          </div>
          <Switch onChange={toggleShowWhatsNew} checked={showWhatsNew} />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(Updates)
