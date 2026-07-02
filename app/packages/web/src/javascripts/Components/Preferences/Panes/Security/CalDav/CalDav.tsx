import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SettingName, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import Switch from '@/Components/Switch/Switch'
import CopyButton from '../TwoFactorAuth/CopyButton'

type Props = {
  application: WebApplication
}

type CaldavToken = {
  uuid: string
  label: string
  scope: string
  createdAt: number | string | null
  lastUsedAt: number | string | null
}

/**
 * Standard Red Notes: the web app consumes the PUBLISHED `@standardnotes/domain-core`,
 * whose `SettingName.NAMES` does not include this setting and whose `create` rejects
 * unknown names. The settings service only needs the name's string `value` at the wire
 * boundary, so we cast a `{ value }` object — the documented cross-dep-tree workaround
 * (same as the email-reminders / reminder-delivery helpers).
 */
const CALDAV_ENABLED_NAME = 'CALDAV_ENABLED'
const caldavEnabledSettingName = { value: CALDAV_ENABLED_NAME } as unknown as SettingName

// The CalDAV sub-router mounts at CALDAV_BASE_PATH (default /dav). We assume the
// default; operators who change it should adjust the pasted URL accordingly.
const CALDAV_BASE_PATH = '/dav'

const formatDate = (value: number | string | null): string => {
  if (value === null || value === undefined || value === '') {
    return 'Never'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const CalDav: FunctionComponent<Props> = ({ application }: Props) => {
  const [isLoading, setIsLoading] = useState(false)
  const [serverEnabled, setServerEnabled] = useState(false)
  const [optIn, setOptIn] = useState(false)
  const [tokens, setTokens] = useState<CaldavToken[]>([])
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)

  const userUuid = application.sessions.getUser()?.uuid
  const subscriptionUrl = userUuid
    ? `${application.legacyApi.getHost().replace(/\/$/, '')}${CALDAV_BASE_PATH}/calendars/${userUuid}/todos/`
    : ''

  const loadTokens = useCallback(async () => {
    try {
      const response = await application.legacyApi.listCaldavTokens()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { tokens?: CaldavToken[] } }).data
        setTokens(data?.tokens ?? [])
      }
    } catch (error) {
      console.error(error)
    }
  }, [application])

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await application.legacyApi.getCaldavConfig()
      let enabled = false
      let allowed = false
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { caldavEnabled?: boolean; allowed?: boolean } }).data
        enabled = Boolean(data?.caldavEnabled)
        allowed = Boolean(data?.allowed)
      }
      setServerEnabled(enabled)
      setOptIn(allowed)
      if (enabled) {
        await loadTokens()
      }
    } finally {
      setIsLoading(false)
    }
  }, [application, loadTokens])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggleOptIn = useCallback(async () => {
    const next = !optIn
    setOptIn(next)
    try {
      await application.settings.updateSetting(caldavEnabledSettingName, next ? 'true' : 'false', false)
    } catch (error) {
      console.error(error)
      setOptIn(!next)
      addToast({ type: ToastType.Error, message: 'Failed to update CalDAV access.' })
    }
  }, [application, optIn])

  const handleCreate = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      addToast({ type: ToastType.Error, message: 'Please enter a label for the CalDAV token.' })
      return
    }

    setCreating(true)
    try {
      const response = await application.legacyApi.createCaldavToken({ label: trimmed })
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create CalDAV token.' })
        return
      }
      const data = (response as { data?: { token?: { token?: string } } }).data
      const token = data?.token?.token
      if (!token) {
        addToast({ type: ToastType.Error, message: 'The server did not return a token.' })
        return
      }
      setCreatedToken(token)
      setLabel('')
      await loadTokens()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create CalDAV token.' })
    } finally {
      setCreating(false)
    }
  }, [application, label, loadTokens])

  const handleDelete = useCallback(
    async (tokenUuid: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to revoke this CalDAV token? Any calendar app using it will immediately lose access.',
        'Revoke CalDAV Token',
        'Revoke',
      )
      if (!confirmed) {
        return
      }
      try {
        const response = await application.legacyApi.deleteCaldavToken(tokenUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke CalDAV token.' })
          return
        }
        await loadTokens()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke CalDAV token.' })
      }
    },
    [application, loadTokens],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>CalDAV Access</Title>
        <Text>
          CalDAV tokens let a calendar app (Apple Calendar, Thunderbird, DAVx5, &hellip;) subscribe to the
          reminders you have published for delivery, as a read-only to-do calendar. Each token is a
          high-entropy secret shown once at creation and stored only as a hash. It is not your account
          password and grants read-only calendar access. Revoke a token to immediately cut off the app
          using it.
        </Text>

        {isLoading ? (
          <Spinner className="mt-3 h-4 w-4" />
        ) : !serverEnabled ? (
          <Text className="mt-2">CalDAV is not enabled on this server.</Text>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between">
              <div className="flex flex-col">
                <Subtitle>Allow CalDAV access</Subtitle>
                <Text>Required before you can create a token. Turning it off revokes access.</Text>
              </div>
              <Switch onChange={() => void handleToggleOptIn()} checked={optIn} />
            </div>
          </>
        )}
      </PreferencesSegment>

      {serverEnabled && optIn && !isLoading && (
        <>
          <HorizontalSeparator classes="my-4" />

          <PreferencesSegment>
            <Subtitle>Create a new CalDAV token</Subtitle>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <DecoratedInput
                className={{ container: 'min-w-0 flex-grow' }}
                placeholder="Label (e.g. Apple Calendar)"
                value={label}
                onChange={(value) => setLabel(value)}
                disabled={creating}
              />
              <Button className="flex-shrink-0" label="Create" primary disabled={creating} onClick={handleCreate} />
            </div>

            {createdToken && (
              <div className="mt-3 rounded border border-solid border-border p-3">
                <Subtitle>Copy your new CalDAV token now</Subtitle>
                <Text className="mb-2">This secret will not be shown again.</Text>
                <div className="flex flex-row items-center gap-2">
                  <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">{createdToken}</code>
                  <CopyButton copyValue={createdToken} successMessage="CalDAV token copied to clipboard" />
                </div>
                {subscriptionUrl && (
                  <>
                    <Subtitle className="mt-3">Calendar subscription URL</Subtitle>
                    <Text className="mb-2">
                      Add a CalDAV account in your calendar app with this URL. Use any username (e.g.{' '}
                      <code className="select-text">caldav</code>) and paste the token above as the password.
                    </Text>
                    <div className="flex flex-row items-center gap-2">
                      <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">
                        {subscriptionUrl}
                      </code>
                      <CopyButton copyValue={subscriptionUrl} successMessage="Subscription URL copied to clipboard" />
                    </div>
                  </>
                )}
                <Button className="mt-3" label="Done" onClick={() => setCreatedToken(null)} />
              </div>
            )}
          </PreferencesSegment>

          <HorizontalSeparator classes="my-4" />

          <PreferencesSegment>
            <Subtitle>Your CalDAV tokens</Subtitle>
            {tokens.length === 0 && <Text className="mt-2">You have no CalDAV tokens.</Text>}
            {tokens.map((token) => (
              <div
                key={token.uuid}
                className="mt-2 flex flex-col gap-2 rounded border border-solid border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="break-words text-base font-medium lg:text-sm">{token.label}</span>
                  <span className="break-words text-sm text-passive-0 lg:text-xs">
                    Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)}
                  </span>
                </div>
                <Button className="flex-shrink-0" label="Revoke" onClick={() => handleDelete(token.uuid)} />
              </div>
            ))}
          </PreferencesSegment>
        </>
      )}
    </PreferencesGroup>
  )
}

export default observer(CalDav)
