import { STRING_FAILED_TO_UPDATE_USER_SETTING } from '@/Constants/Strings'
import { useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { observer } from 'mobx-react-lite'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Spinner from '@/Components/Spinner/Spinner'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import DecoratedPasswordInput from '@/Components/Input/DecoratedPasswordInput'
import Button from '@/Components/Button/Button'
import {
  getNextcloudBackupValidationError,
  NextcloudBackupFrequency,
  NextcloudBackupSettingName,
  NextcloudFrequency,
  saveNextcloudBackupSettings,
} from './NextcloudBackupSettings'

type Props = {
  application: WebApplication
}

const FREQUENCY_LABELS: Record<NextcloudFrequency, string> = {
  disabled: 'No Nextcloud backups',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

const frequencyOptions: DropdownItem[] = (Object.keys(FREQUENCY_LABELS) as NextcloudFrequency[]).map((value) => ({
  value,
  label: FREQUENCY_LABELS[value],
}))

const NextcloudBackups = ({ application }: Props) => {
  const hasAccount = application.hasAccount()
  const [isLoading, setIsLoading] = useState(hasAccount)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [isSaving, setIsSaving] = useState(false)
  const [frequency, setFrequency] = useState<NextcloudFrequency>(NextcloudBackupFrequency.Disabled)
  const [persistedFrequency, setPersistedFrequency] = useState<NextcloudFrequency>(NextcloudBackupFrequency.Disabled)
  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [appPasswordIsSet, setAppPasswordIsSet] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | undefined>()
  const validationError = getNextcloudBackupValidationError({
    frequency,
    persistedFrequency,
    url,
    folder,
    appPassword,
    appPasswordIsSet,
  })

  const load = useCallback(async () => {
    if (!application.sessions.getUser()) {
      setLoadError('Sign in again before changing Nextcloud backup settings.')
      setHasLoaded(true)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setLoadError(undefined)
    try {
      const userSettings = await application.settings.listSettings()
      const loadedFrequency = userSettings.getRawSettingValue<NextcloudFrequency, NextcloudFrequency>(
        NextcloudBackupSettingName.Frequency,
        NextcloudBackupFrequency.Disabled,
      )
      setFrequency(loadedFrequency)
      setPersistedFrequency(loadedFrequency)
      setUrl(userSettings.getRawSettingValue<string, string>(NextcloudBackupSettingName.Url, ''))
      setFolder(userSettings.getRawSettingValue<string, string>(NextcloudBackupSettingName.Folder, ''))
      // The app password is SENSITIVE: the server never returns its value. We can
      // only learn whether one is stored, and let the user replace it.
      const appPasswordExists = await application.settings.getDoesRawSensitiveSettingExist(
        NextcloudBackupSettingName.AppPassword,
      )
      setAppPasswordIsSet(appPasswordExists)
      setHasLoaded(true)
    } catch (error) {
      console.error(error)
      setLoadError('Could not load the active Nextcloud backup settings. No changes were made.')
    } finally {
      setIsLoading(false)
    }
  }, [application])

  useEffect(() => {
    load().catch(console.error)
  }, [load])

  const updateSetting = async (settingName: string, payload: string, sensitive = false): Promise<boolean> => {
    try {
      await application.settings.updateRawSetting(settingName, payload, sensitive)
      return true
    } catch {
      application.alerts.alert(STRING_FAILED_TO_UPDATE_USER_SETTING()).catch(console.error)
      return false
    }
  }

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    setSaveStatus(undefined)
    try {
      const result = await saveNextcloudBackupSettings(
        { frequency, persistedFrequency, url, folder, appPassword, appPasswordIsSet },
        updateSetting,
      )
      setPersistedFrequency(result.effectiveFrequency)
      // Reflect the server's effective state, not an unsaved requested cadence.
      // This is especially important when fail-closed pre-disable succeeded but
      // a later destination write or final reactivation did not.
      setFrequency(result.effectiveFrequency)
      if (result.appPasswordSaved) {
        setAppPassword('')
        setAppPasswordIsSet(true)
      }
      if (result.success) {
        setSaveStatus({
          type: 'success',
          message:
            result.effectiveFrequency === NextcloudBackupFrequency.Disabled
              ? 'Nextcloud backup settings saved. Scheduled uploads are disabled.'
              : 'Nextcloud backup settings saved and scheduling re-enabled safely.',
        })
      } else {
        setSaveStatus({
          type: 'error',
          message:
            result.effectiveFrequency === NextcloudBackupFrequency.Disabled
              ? 'Saving stopped at the first failed setting. Scheduled uploads remain disabled; correct the error and save again.'
              : 'Saving stopped before the active configuration was changed. Correct the error and try again.',
        })
      }
    } finally {
      setIsSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application, url, folder, frequency, persistedFrequency, appPassword, appPasswordIsSet])

  if (!hasAccount) {
    return null
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Nextcloud backups</Title>

        <Text className="mb-3">
          Upload encrypted backups of all your notes to your own Nextcloud server on the schedule you choose. Your data
          is uploaded exactly as it is stored on the server: end-to-end encrypted. Nextcloud receives only this
          ciphertext and cannot read your notes; you will need your account password to decrypt and restore the backup.
          This is a backup, not a sync replacement. Backups are only uploaded if your server operator has enabled
          Nextcloud backups.
        </Text>

        <div className="border-danger bg-danger-faded my-3 rounded border p-3" role="alert">
          <span className="border-danger text-danger mb-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-bold tracking-wide uppercase">
            Security requirement
          </span>
          <Subtitle className="text-danger">HTTPS and a dedicated app password are mandatory</Subtitle>
          <Text className="mt-1">
            The Nextcloud app password you enter is stored on the Standard Red Notes server and grants access to your
            Nextcloud files. Your note content stays end-to-end encrypted (Nextcloud cannot read it), but the app
            password, the timing of each upload, and the size of each backup file are exposed to whoever controls the
            server or your Nextcloud instance. Use a dedicated, low-privilege Nextcloud <strong>app password</strong>{' '}
            &mdash; never your main Nextcloud login password &mdash; and revoke it from Nextcloud at any time to stop
            uploads. The base URL must use HTTPS and must already be the final URL; redirects are rejected so
            credentials cannot be forwarded to another origin.
          </Text>
        </div>

        {isLoading || (!hasLoaded && !loadError) ? (
          <Spinner className="h-5 w-5 flex-shrink-0" />
        ) : loadError ? (
          <div className="border-danger bg-danger-faded text-danger rounded border p-3" role="alert">
            <Text>{loadError}</Text>
            <Button className="mt-3" label="Retry loading settings" onClick={() => void load()} />
          </div>
        ) : (
          <>
            <div className="mb-3">
              <Subtitle>Nextcloud URL</Subtitle>
              <Text>The base address of your Nextcloud instance, e.g. https://cloud.example.com</Text>
              <div className="mt-2">
                <DecoratedInput
                  placeholder="https://cloud.example.com"
                  value={url}
                  onChange={(value) => {
                    setSaveStatus(undefined)
                    setUrl(value)
                  }}
                  autocomplete={false}
                />
              </div>
            </div>

            <div className="mb-3">
              <Subtitle>App password</Subtitle>
              <Text>
                A dedicated Nextcloud app password (Settings &rarr; Security &rarr; Devices &amp; sessions). Not your
                login password.{' '}
                {appPasswordIsSet ? 'An app password is currently stored.' : 'No app password stored yet.'}
              </Text>
              <div className="mt-2">
                <DecoratedPasswordInput
                  placeholder={appPasswordIsSet ? 'Leave blank to keep current app password' : 'Enter app password'}
                  value={appPassword}
                  onChange={(value) => {
                    setSaveStatus(undefined)
                    setAppPassword(value)
                  }}
                />
              </div>
            </div>

            <div className="mb-3">
              <Subtitle>Folder</Subtitle>
              <Text>
                Optional destination folder within your Nextcloud files, e.g. Backups/StandardNotes. Leave blank to
                upload to your WebDAV account root.
              </Text>
              <div className="mt-2">
                <DecoratedInput
                  placeholder="Backups/StandardNotes"
                  value={folder}
                  onChange={(value) => {
                    setSaveStatus(undefined)
                    setFolder(value)
                  }}
                  autocomplete={false}
                />
              </div>
            </div>

            <div className="mb-3">
              <Subtitle>Frequency</Subtitle>
              <Text>How often to upload a backup.</Text>
              <div className="mt-2">
                <Dropdown
                  label="Select Nextcloud backup frequency"
                  items={frequencyOptions}
                  value={frequency}
                  onChange={(item) => {
                    setSaveStatus(undefined)
                    setFrequency(item as NextcloudFrequency)
                  }}
                />
              </div>
            </div>

            {validationError && (
              <div className="border-danger bg-danger-faded text-danger mb-3 rounded border p-3 text-sm" role="alert">
                <strong>Configuration not saved:</strong> {validationError}
              </div>
            )}

            {saveStatus && (
              <div
                className={`mb-3 rounded border p-3 text-sm ${
                  saveStatus.type === 'error'
                    ? 'border-danger bg-danger-faded text-danger'
                    : 'border-success bg-success-faded text-success'
                }`}
                role={saveStatus.type === 'error' ? 'alert' : 'status'}
              >
                {saveStatus.message}
              </div>
            )}

            <Button
              label={isSaving ? 'Saving…' : 'Save'}
              disabled={isSaving || validationError !== undefined}
              onClick={() => void handleSave()}
            />
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(NextcloudBackups)
