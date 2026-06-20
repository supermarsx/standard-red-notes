import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import CopyButton from '../TwoFactorAuth/CopyButton'

type Props = {
  application: WebApplication
}

type AppPassword = {
  uuid: string
  label: string
  createdAt: string
  lastUsedAt: string | null
}

const formatDate = (value: string | null): string => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const AppPasswords: FunctionComponent<Props> = ({ application }: Props) => {
  const [appPasswords, setAppPasswords] = useState<AppPassword[]>([])
  const [loading, setLoading] = useState(false)
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const loadAppPasswords = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listAppPasswords()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { appPasswords?: AppPassword[] } }).data
        setAppPasswords(data?.appPasswords ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadAppPasswords()
  }, [loadAppPasswords])

  const handleCreate = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      addToast({ type: ToastType.Error, message: 'Please enter a label for the app password.' })
      return
    }

    setCreating(true)
    try {
      const response = await application.legacyApi.createAppPassword(trimmed)
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create app password.' })
        return
      }

      const data = (response as { data?: { password?: string } }).data
      setCreatedSecret(data?.password ?? null)
      setLabel('')
      await loadAppPasswords()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create app password.' })
    } finally {
      setCreating(false)
    }
  }, [application, label, loadAppPasswords])

  const handleDelete = useCallback(
    async (appPasswordId: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to revoke this app password? Any client using it will lose access.',
        'Revoke App Password',
        'Revoke',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.deleteAppPassword(appPasswordId)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke app password.' })
          return
        }
        await loadAppPasswords()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke app password.' })
      }
    },
    [application, loadAppPasswords],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>App Passwords</Title>
        <Text>
          App passwords let headless or automation clients (such as the MCP bridge) sign in without an interactive
          two-factor code. Each is a high-entropy secret stored only as a hash; it is shown once at creation and never
          again. Revoke a password to immediately cut off any client using it.
        </Text>
        <Text className="mt-2">
          Note: an app password only satisfies the server's two-factor challenge. It does not unlock your encrypted
          data — that still requires your real account password.
        </Text>

        <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
          <Subtitle className="text-warning">An app password can sign in and reach your decrypted notes</Subtitle>
          <Text className="mt-1">
            A headless or automation client holding this secret can sign in to your account without an interactive
            two-factor prompt and, once it has your account password, access your decrypted notes. Treat an app password
            like a full account password: store it securely, never share it, and revoke it immediately if it is leaked
            or no longer needed.
          </Text>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Create a new app password</Subtitle>
        <div className="mt-2 flex flex-row items-center gap-2">
          <DecoratedInput
            placeholder="Label (e.g. MCP Bridge)"
            value={label}
            onChange={(value) => setLabel(value)}
            disabled={creating}
          />
          <Button label="Create" primary disabled={creating} onClick={handleCreate} />
        </div>

        {createdSecret && (
          <div className="mt-3 rounded border border-solid border-border p-3">
            <Subtitle>Copy your new app password now</Subtitle>
            <Text className="mb-2">This secret will not be shown again.</Text>
            <div className="flex flex-row items-center gap-2">
              <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">{createdSecret}</code>
              <CopyButton copyValue={createdSecret} />
            </div>
            <Button className="mt-3" label="Done" onClick={() => setCreatedSecret(null)} />
          </div>
        )}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Your app passwords</Subtitle>
        {loading && <Spinner className="mt-2 h-4 w-4" />}
        {!loading && appPasswords.length === 0 && <Text className="mt-2">You have no app passwords.</Text>}
        {!loading &&
          appPasswords.map((appPassword) => (
            <div
              key={appPassword.uuid}
              className="mt-2 flex flex-row items-center justify-between rounded border border-solid border-border p-3"
            >
              <div className="flex flex-col">
                <span className="text-base font-medium lg:text-sm">{appPassword.label}</span>
                <span className="text-sm text-passive-0 lg:text-xs">
                  Created {formatDate(appPassword.createdAt)} · Last used {formatDate(appPassword.lastUsedAt)}
                </span>
              </div>
              <Button label="Revoke" onClick={() => handleDelete(appPassword.uuid)} />
            </div>
          ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(AppPasswords)
