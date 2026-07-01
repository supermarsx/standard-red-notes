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
import Checkbox from '@/Components/Checkbox/Checkbox'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import CopyButton from '../TwoFactorAuth/CopyButton'

type Props = {
  application: WebApplication
}

type Webhook = {
  uuid: string
  // null => global webhook (fires for all users); only admins can create these.
  userUuid: string | null
  targetUrl: string
  events: string[]
  enabled: boolean
  createdAt: string
}

// Fallback catalogue matching the server's WebhookEvent.ts. The list endpoint
// also returns `availableEvents`, which is preferred at runtime so the UI stays
// in sync with the server; this constant is only used until that arrives and to
// provide human-friendly labels.
const KNOWN_WEBHOOK_EVENTS: string[] = [
  'item.created',
  'item.updated',
  'item.deleted',
  'user.login',
  'session.revoked',
  'admin.action',
]

const EVENT_DESCRIPTIONS: Record<string, string> = {
  'item.created': 'A note or other item was created',
  'item.updated': 'A note or other item was updated',
  'item.deleted': 'A note or other item was deleted',
  'user.login': 'The account signed in',
  'session.revoked': 'A session was revoked / signed out',
  'admin.action': 'An administrator action occurred',
}

const formatDate = (value: string | null): string => {
  if (!value) {
    return 'Unknown'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const isValidHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const Webhooks: FunctionComponent<Props> = ({ application }: Props) => {
  const isAdmin = application.featuresController.isAdminUser()

  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [availableEvents, setAvailableEvents] = useState<string[]>(KNOWN_WEBHOOK_EVENTS)
  const [loading, setLoading] = useState(false)
  const [targetUrl, setTargetUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])
  const [global, setGlobal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const loadWebhooks = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listWebhooks()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { webhooks?: Webhook[]; availableEvents?: string[] } }).data
        setWebhooks(data?.webhooks ?? [])
        if (data?.availableEvents && data.availableEvents.length > 0) {
          setAvailableEvents(data.availableEvents)
        }
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadWebhooks()
  }, [loadWebhooks])

  const toggleEvent = useCallback((event: string) => {
    setSelectedEvents((current) => {
      return current.includes(event) ? current.filter((name) => name !== event) : [...current, event]
    })
  }, [])

  const handleCreate = useCallback(async () => {
    const trimmed = targetUrl.trim()
    if (!isValidHttpUrl(trimmed)) {
      addToast({ type: ToastType.Error, message: 'Please enter a valid http(s) URL for the webhook target.' })
      return
    }
    if (selectedEvents.length === 0) {
      addToast({ type: ToastType.Error, message: 'Please select at least one event to subscribe to.' })
      return
    }

    setCreating(true)
    try {
      const response = await application.legacyApi.createWebhook({
        targetUrl: trimmed,
        events: selectedEvents,
        global: isAdmin && global ? true : undefined,
      })

      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create webhook.' })
        return
      }

      const data = (response as { data?: { secret?: string } }).data
      const secret = data?.secret
      if (!secret) {
        addToast({ type: ToastType.Error, message: 'The server did not return a signing secret.' })
        return
      }

      // The HMAC secret is returned exactly once and never again; show it now.
      setCreatedSecret(secret)
      setTargetUrl('')
      setSelectedEvents([])
      setGlobal(false)
      await loadWebhooks()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create webhook.' })
    } finally {
      setCreating(false)
    }
  }, [application, targetUrl, selectedEvents, global, isAdmin, loadWebhooks])

  const handleDelete = useCallback(
    async (webhookId: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to delete this webhook? Standard Red Notes will immediately stop delivering events to it.',
        'Delete Webhook',
        'Delete',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.deleteWebhook(webhookId)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to delete webhook.' })
          return
        }
        await loadWebhooks()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to delete webhook.' })
      }
    },
    [application, loadWebhooks],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Webhooks</Title>
        <Text>
          Webhooks let you connect Standard Red Notes to automation tools (n8n, Zapier, Typeform, or your own service).
          When a subscribed event occurs, Standard Red Notes sends an HTTP POST to your target URL with a small
          non-sensitive payload (uuids, timestamps, and metadata only — never your decrypted note content).
        </Text>
        <Text className="mt-2">
          Each delivery is signed with an HMAC-SHA256 signature in the <code>X-SRN-Signature</code> header (
          <code>sha256=&lt;hex&gt;</code>). Verify it on the receiving side using the signing secret shown once when you
          create the webhook.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Create a new webhook</Subtitle>
        <div className="mt-2 flex flex-col gap-2">
          <DecoratedInput
            placeholder="Target URL (e.g. https://example.com/hooks/srn)"
            value={targetUrl}
            onChange={(value) => setTargetUrl(value)}
            disabled={creating}
          />

          <div className="mt-1 flex flex-col">
            <Subtitle>Events</Subtitle>
            <Text className="mb-2">Select which events should be delivered to this webhook.</Text>
            {availableEvents.map((event) => (
              <Checkbox
                key={event}
                name={`webhook-event-${event}`}
                label={`${event}${EVENT_DESCRIPTIONS[event] ? ` — ${EVENT_DESCRIPTIONS[event]}` : ''}`}
                checked={selectedEvents.includes(event)}
                onChange={() => toggleEvent(event)}
                disabled={creating}
              />
            ))}
          </div>

          {isAdmin && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <Subtitle>Global (all users)</Subtitle>
                <Text>
                  As an administrator, register this webhook for every user on this instance rather than only your own
                  account. It will fire for the matching events of any user.
                </Text>
              </div>
              <Switch checked={global} onChange={setGlobal} disabled={creating} />
            </div>
          )}

          <div>
            <Button label="Create" primary disabled={creating} onClick={handleCreate} />
          </div>
        </div>

        {createdSecret && (
          <div className="mt-3 rounded border border-solid border-warning bg-warning-faded p-3">
            <Subtitle className="text-warning">Copy your webhook signing secret now</Subtitle>
            <Text className="mb-2">
              This is the only time this secret is shown. Store it now — use it to verify the{' '}
              <code>X-SRN-Signature</code> header on incoming deliveries. It cannot be retrieved again; delete and
              recreate the webhook if you lose it.
            </Text>
            <div className="flex flex-row items-center gap-2">
              <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">{createdSecret}</code>
              <CopyButton copyValue={createdSecret} successMessage="Webhook secret copied to clipboard" />
            </div>
            <Button className="mt-3" label="Done" onClick={() => setCreatedSecret(null)} />
          </div>
        )}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Your webhooks</Subtitle>
        {loading && <Spinner className="mt-2 h-4 w-4" />}
        {!loading && webhooks.length === 0 && <Text className="mt-2">You have no webhooks.</Text>}
        {!loading &&
          webhooks.map((webhook) => (
            <div
              key={webhook.uuid}
              className="mt-2 flex flex-col gap-2 rounded border border-solid border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <span className="break-all text-base font-medium lg:text-sm">{webhook.targetUrl}</span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  {webhook.events.length > 0 ? webhook.events.join(', ') : 'no events'}
                </span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  {webhook.userUuid === null ? 'Global · ' : ''}
                  {webhook.enabled ? 'Enabled' : 'Disabled'} · Created {formatDate(webhook.createdAt)}
                </span>
              </div>
              <Button className="flex-shrink-0" label="Delete" onClick={() => handleDelete(webhook.uuid)} />
            </div>
          ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(Webhooks)
