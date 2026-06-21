import { STRING_FAILED_TO_UPDATE_USER_SETTING } from '@/Constants/Strings'
import { useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { observer } from 'mobx-react-lite'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import { SettingName } from '@standardnotes/snjs'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Spinner from '@/Components/Spinner/Spinner'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import DecoratedPasswordInput from '@/Components/Input/DecoratedPasswordInput'
import Button from '@/Components/Button/Button'

type Props = {
  application: WebApplication
}

// Standard Red Notes: Nextcloud backup frequency. Mirrors the email-backup
// frequency; defined locally (string values match the server enum) so the pane does
// not depend on the published @standardnotes/settings adding the enum.
const NextcloudBackupFrequency = {
  Disabled: 'disabled',
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
} as const

type NextcloudFrequency = (typeof NextcloudBackupFrequency)[keyof typeof NextcloudBackupFrequency]

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
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [frequency, setFrequency] = useState<NextcloudFrequency>(NextcloudBackupFrequency.Disabled)
  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [appPasswordIsSet, setAppPasswordIsSet] = useState(false)

  const load = useCallback(async () => {
    if (!application.sessions.getUser()) {
      return
    }
    setIsLoading(true)
    try {
      const userSettings = await application.settings.listSettings()
      setFrequency(
        userSettings.getSettingValue<NextcloudFrequency, NextcloudFrequency>(
          SettingName.create(SettingName.NAMES.NextcloudBackupFrequency).getValue(),
          NextcloudBackupFrequency.Disabled,
        ),
      )
      setUrl(
        userSettings.getSettingValue<string, string>(
          SettingName.create(SettingName.NAMES.NextcloudBackupUrl).getValue(),
          '',
        ),
      )
      setFolder(
        userSettings.getSettingValue<string, string>(
          SettingName.create(SettingName.NAMES.NextcloudBackupFolder).getValue(),
          '',
        ),
      )
      // The app password is SENSITIVE: the server never returns its value. We can
      // only learn whether one is stored, and let the user replace it.
      const appPasswordExists = await application.settings.getDoesSensitiveSettingExist(
        SettingName.create(SettingName.NAMES.NextcloudBackupAppPassword).getValue(),
      )
      setAppPasswordIsSet(appPasswordExists)
    } catch (error) {
      console.error(error)
    } finally {
      setIsLoading(false)
    }
  }, [application])

  useEffect(() => {
    load().catch(console.error)
  }, [load])

  const updateSetting = async (settingName: SettingName, payload: string, sensitive = false): Promise<boolean> => {
    try {
      await application.settings.updateSetting(settingName, payload, sensitive)
      return true
    } catch (e) {
      application.alerts.alert(STRING_FAILED_TO_UPDATE_USER_SETTING()).catch(console.error)
      return false
    }
  }

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      await updateSetting(SettingName.create(SettingName.NAMES.NextcloudBackupUrl).getValue(), url.trim())
      await updateSetting(SettingName.create(SettingName.NAMES.NextcloudBackupFolder).getValue(), folder.trim())
      await updateSetting(SettingName.create(SettingName.NAMES.NextcloudBackupFrequency).getValue(), frequency)
      // Only write the app password if the user typed a new one; otherwise we keep
      // the existing stored (sensitive) value untouched.
      if (appPassword.trim() !== '') {
        const ok = await updateSetting(
          SettingName.create(SettingName.NAMES.NextcloudBackupAppPassword).getValue(),
          appPassword.trim(),
          true,
        )
        if (ok) {
          setAppPassword('')
          setAppPasswordIsSet(true)
        }
      }
    } finally {
      setIsSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application, url, folder, frequency, appPassword])

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

        <div className="my-3 rounded border border-warning bg-warning-faded p-3">
          <Subtitle className="text-warning">Privacy: read before enabling</Subtitle>
          <Text className="mt-1">
            The Nextcloud app password you enter is stored on the Standard Red Notes server and grants access to your
            Nextcloud files. Your note content stays end-to-end encrypted (Nextcloud cannot read it), but the app
            password, the timing of each upload, and the size of each backup file are exposed to whoever controls the
            server or your Nextcloud instance. Use a dedicated, low-privilege Nextcloud{' '}
            <strong>app password</strong> &mdash; never your main Nextcloud login password &mdash; and revoke it from
            Nextcloud at any time to stop uploads.
          </Text>
        </div>

        {isLoading ? (
          <Spinner className="h-5 w-5 flex-shrink-0" />
        ) : (
          <>
            <div className="mb-3">
              <Subtitle>Nextcloud URL</Subtitle>
              <Text>The base address of your Nextcloud instance, e.g. https://cloud.example.com</Text>
              <div className="mt-2">
                <DecoratedInput
                  placeholder="https://cloud.example.com"
                  value={url}
                  onChange={setUrl}
                  autocomplete={false}
                />
              </div>
            </div>

            <div className="mb-3">
              <Subtitle>App password</Subtitle>
              <Text>
                A dedicated Nextcloud app password (Settings &rarr; Security &rarr; Devices &amp; sessions). Not your
                login password. {appPasswordIsSet ? 'An app password is currently stored.' : 'No app password stored yet.'}
              </Text>
              <div className="mt-2">
                <DecoratedPasswordInput
                  placeholder={appPasswordIsSet ? 'Leave blank to keep current app password' : 'Enter app password'}
                  value={appPassword}
                  onChange={setAppPassword}
                />
              </div>
            </div>

            <div className="mb-3">
              <Subtitle>Folder</Subtitle>
              <Text>Destination folder within your Nextcloud files, e.g. Backups/StandardNotes</Text>
              <div className="mt-2">
                <DecoratedInput
                  placeholder="Backups/StandardNotes"
                  value={folder}
                  onChange={setFolder}
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
                  onChange={(item) => setFrequency(item as NextcloudFrequency)}
                />
              </div>
            </div>

            <Button label={isSaving ? 'Saving…' : 'Save'} disabled={isSaving} onClick={() => void handleSave()} />
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(NextcloudBackups)
