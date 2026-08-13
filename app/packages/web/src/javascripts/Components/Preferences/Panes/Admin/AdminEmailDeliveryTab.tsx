import { FunctionComponent, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Spinner from '@/Components/Spinner/Spinner'
import { AdminServerSettings, settingSource, settingSourceChipClass, settingSourceLabel } from './adminHelpers'
import EmailDeliveryControlPlane from './EmailDeliveryControlPlane'

type EmailDeliveryPatch = Parameters<WebApplication['legacyApi']['adminSetServerSettings']>[0]

type Props = {
  application: WebApplication
  settings: AdminServerSettings | null
  sources: Record<string, string> | null
  loading: boolean
  unavailable: boolean
  error: string | null
  saving: boolean
  noteIfForbidden: (response: { status?: number }) => void
  onRetry: () => void
  saveSettings: (partial: EmailDeliveryPatch, successMessage: string) => Promise<boolean>
}

const TLS_ITEMS = [
  { label: 'STARTTLS (recommended, usually port 587)', value: 'starttls' },
  { label: 'Implicit TLS (usually port 465)', value: 'implicit' },
  { label: 'Insecure private relay (no TLS)', value: 'insecure' },
]

const SourceChip: FunctionComponent<{ sources: Record<string, string> | null; keyName: string }> = ({
  sources,
  keyName,
}) => {
  const source = settingSource(sources, keyName)

  return (
    <span className={`rounded px-2 py-0.5 text-xs font-bold ${settingSourceChipClass(source)}`}>
      {settingSourceLabel(source)}
    </span>
  )
}

const FieldLabel: FunctionComponent<{
  htmlFor: string
  label: string
  sources: Record<string, string> | null
  sourceKey: string
}> = ({ htmlFor, label, sources, sourceKey }) => (
  <div className="mb-1 flex flex-wrap items-center gap-2">
    <label htmlFor={htmlFor} className="text-sm font-semibold">
      {label}
    </label>
    <SourceChip sources={sources} keyName={sourceKey} />
  </div>
)

const AdminEmailDeliveryTab: FunctionComponent<Props> = ({
  application,
  settings,
  sources,
  loading,
  unavailable,
  error,
  saving,
  noteIfForbidden,
  onRetry,
  saveSettings,
}) => {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [from, setFrom] = useState('')
  const [tlsMode, setTlsMode] = useState<'implicit' | 'starttls' | 'insecure'>('starttls')
  const [testRecipient, setTestRecipient] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const emailDelivery = settings?.emailDelivery
  useEffect(() => {
    setHost(emailDelivery?.host ?? '')
    setPort(String(emailDelivery?.port ?? 587))
    setUsername(emailDelivery?.username ?? '')
    setFrom(emailDelivery?.from ?? '')
    setTlsMode(emailDelivery?.tlsMode ?? 'starttls')
    setPassword('')
    setClearPassword(false)
  }, [emailDelivery])

  const save = async (): Promise<void> => {
    const parsedPort = Number(port)
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      addToast({ type: ToastType.Error, message: 'SMTP port must be an integer between 1 and 65535.' })
      return
    }

    const patch: EmailDeliveryPatch = {
      emailDelivery: {
        host: host.trim() || null,
        port: parsedPort,
        username: username.trim() || null,
        from: from.trim() || null,
        tlsMode,
        ...(password.length > 0 ? { password } : clearPassword ? { password: null } : {}),
      },
    }
    const saved = await saveSettings(patch, 'Email delivery settings saved.')
    if (saved) {
      setPassword('')
      setClearPassword(false)
    }
  }

  const testDelivery = async (): Promise<void> => {
    if (!/^\S+@\S+$/.test(testRecipient.trim())) {
      setTestResult('Enter a valid recipient email address.')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const response = await application.legacyApi.adminTestEmailDelivery(testRecipient.trim())
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setTestResult('The test failed. Check the SMTP settings and the server logs.')
        return
      }
      setTestResult('The SMTP server accepted the test email.')
    } catch {
      setTestResult('The test failed. Check the SMTP settings and the server logs.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <PreferencesSegment>
      <Title>Email delivery</Title>
      <Text>
        Configure one outbound SMTP connection for sign-in and account emails, email backups, and published reminder
        delivery. Saved values take effect on the next send and override the matching environment value.
      </Text>

      {loading ? (
        <Spinner className="mt-3 h-5 w-5" />
      ) : unavailable ? (
        <Text className="mt-3">Email delivery settings are unavailable on this server. Update the server first.</Text>
      ) : error ? (
        <div className="mt-3">
          <Text className="text-danger">{error}</Text>
          <Button className="mt-2" label="Retry" onClick={onRetry} />
        </div>
      ) : (
        <div className="mt-4 flex max-w-3xl flex-col gap-4">
          <div
            className={`rounded border p-3 ${
              emailDelivery?.configured ? 'border-success bg-success-faded' : 'border-border bg-passive-5'
            }`}
          >
            <Subtitle>{emailDelivery?.configured ? 'Ready to send' : 'Not configured'}</Subtitle>
            <Text className="mt-1 text-xs">
              Password: {emailDelivery?.passwordConfigured ? 'configured (write-only)' : 'not configured'}. Passwords
              and raw provider errors are never returned to this page.
            </Text>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <FieldLabel
                htmlFor="email-smtp-host"
                label="SMTP host"
                sources={sources}
                sourceKey="emailDelivery.host"
              />
              <DecoratedInput
                id="email-smtp-host"
                placeholder="smtp.example.com"
                value={host}
                onChange={setHost}
                disabled={saving}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor="email-smtp-port"
                label="SMTP port"
                sources={sources}
                sourceKey="emailDelivery.port"
              />
              <DecoratedInput id="email-smtp-port" type="number" value={port} onChange={setPort} disabled={saving} />
            </div>
            <div>
              <FieldLabel
                htmlFor="email-smtp-username"
                label="Username"
                sources={sources}
                sourceKey="emailDelivery.username"
              />
              <DecoratedInput
                id="email-smtp-username"
                autocomplete={false}
                value={username}
                onChange={setUsername}
                disabled={saving}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor="email-smtp-password"
                label="Password (write-only)"
                sources={sources}
                sourceKey="emailDelivery.password"
              />
              <DecoratedInput
                id="email-smtp-password"
                type="password"
                placeholder={emailDelivery?.passwordConfigured ? 'Leave blank to preserve' : 'Enter password'}
                value={password}
                onChange={(value) => {
                  setPassword(value)
                  if (value.length > 0) {
                    setClearPassword(false)
                  }
                }}
                disabled={saving || clearPassword}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  label={clearPassword ? 'Cancel password clear' : 'Clear saved password'}
                  onClick={() => {
                    setClearPassword((value) => !value)
                    setPassword('')
                  }}
                  disabled={saving || !emailDelivery?.passwordConfigured}
                />
                {clearPassword ? (
                  <Text className="text-warning text-xs">
                    The saved override will be cleared on Save; an environment password may become active.
                  </Text>
                ) : null}
              </div>
            </div>
            <div>
              <FieldLabel
                htmlFor="email-smtp-from"
                label="From identity"
                sources={sources}
                sourceKey="emailDelivery.from"
              />
              <DecoratedInput
                id="email-smtp-from"
                placeholder="Standard Red Notes <notes@example.com>"
                value={from}
                onChange={setFrom}
                disabled={saving}
              />
            </div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <label className="text-sm font-semibold">TLS mode</label>
                <SourceChip sources={sources} keyName="emailDelivery.tlsMode" />
              </div>
              <Dropdown
                label="SMTP TLS mode"
                items={TLS_ITEMS}
                value={tlsMode}
                onChange={(value) => setTlsMode(value as typeof tlsMode)}
                disabled={saving}
              />
            </div>
          </div>

          {tlsMode === 'insecure' ? (
            <div className="border-danger bg-danger-faded rounded border p-3" role="alert">
              <Subtitle>Insecure transport exposes email and credentials</Subtitle>
              <Text className="mt-1 text-xs">
                The server accepts this mode only for an explicitly trusted loopback, private-IP, localhost, or
                <code>.localhost</code> relay. Public and unresolved internal hostnames are rejected.
              </Text>
            </div>
          ) : null}

          <div>
            <Button label={saving ? 'Saving…' : 'Save email delivery'} onClick={() => void save()} disabled={saving} />
          </div>

          <div className="border-border mt-2 border-t pt-4">
            <Subtitle>Send a test email</Subtitle>
            <Text className="mt-1 text-xs">
              Uses the currently saved effective settings. The result is deliberately redacted.
            </Text>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'w-96 max-w-full' }}
                placeholder="operator@example.com"
                value={testRecipient}
                onChange={setTestRecipient}
                onEnter={() => void testDelivery()}
                disabled={testing}
              />
              <Button
                label={testing ? 'Sending…' : 'Send test'}
                onClick={() => void testDelivery()}
                disabled={testing || !emailDelivery?.configured}
              />
            </div>
            {testResult ? (
              <div role="status">
                <Text className="mt-2 text-xs">{testResult}</Text>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <EmailDeliveryControlPlane application={application} noteIfForbidden={noteIfForbidden} />
    </PreferencesSegment>
  )
}

export default AdminEmailDeliveryTab
