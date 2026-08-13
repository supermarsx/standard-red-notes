import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Spinner from '@/Components/Spinner/Spinner'
import Switch from '@/Components/Switch/Switch'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import {
  DELIVERY_CHANNELS,
  DeliveryChannel,
  PublishedReminder,
  channelLabel,
  destinationHint,
  destinationLabel,
  destinationPlaceholder,
  getDeliveryConfig,
  getReminderDeliveryConfig,
  getReminderDeliveryOptIn,
  listPublishedReminders,
  setDeliveryConfig,
  setReminderDeliveryOptIn,
  validateDestination,
} from '@/Reminders/reminderDelivery'

type Props = {
  application: WebApplication
}

const formatDateTime = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const ReminderDelivery = ({ application }: Props) => {
  const hasAccount = application.hasAccount()

  const [isLoading, setIsLoading] = useState(false)
  const [serverEnabled, setServerEnabled] = useState(false)
  const [optIn, setOptIn] = useState(false)

  const [channel, setChannel] = useState<DeliveryChannel>('whatsapp')
  const [destination, setDestination] = useState('')
  const [destinationTouched, setDestinationTouched] = useState(false)
  const [deliveryEnabled, setDeliveryEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [published, setPublished] = useState<PublishedReminder[]>([])

  const destinationError =
    destination.trim().length > 0 || destinationTouched ? validateDestination(channel, destination) : null

  const load = useCallback(async () => {
    if (!hasAccount) {
      return
    }
    setIsLoading(true)
    try {
      const [config, optInValue] = await Promise.all([
        getReminderDeliveryConfig(application),
        getReminderDeliveryOptIn(application),
      ])
      setServerEnabled(config.reminderDeliveryEnabled)
      setOptIn(optInValue || config.allowed)

      if (config.available) {
        const [delivery, publishedList] = await Promise.all([
          getDeliveryConfig(application),
          listPublishedReminders(application),
        ])
        if (delivery) {
          setChannel(delivery.channel)
          setDestination(delivery.destination)
          setDeliveryEnabled(delivery.enabled)
        }
        setPublished(publishedList)
      }
    } finally {
      setIsLoading(false)
    }
  }, [application, hasAccount])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggleOptIn = useCallback(async () => {
    const next = !optIn
    setOptIn(next)
    const ok = await setReminderDeliveryOptIn(application, next)
    if (!ok) {
      setOptIn(!next)
      addToast({ type: ToastType.Error, message: 'Failed to update reminder delivery opt-in.' })
      return
    }
    // Opting in unlocks the server delivery config; opting out disables delivery.
    if (next) {
      const delivery = await getDeliveryConfig(application)
      if (delivery) {
        setChannel(delivery.channel)
        setDestination(delivery.destination)
        setDeliveryEnabled(delivery.enabled)
      }
    } else {
      setDeliveryEnabled(false)
      setDestination('')
      setDestinationTouched(false)
      setPublished([])
    }
  }, [application, optIn])

  const handleSave = useCallback(async () => {
    const trimmed = destination.trim()
    if (deliveryEnabled) {
      const error = validateDestination(channel, trimmed)
      if (error) {
        addToast({ type: ToastType.Error, message: error })
        return
      }
    }
    setSaving(true)
    try {
      const saved = await setDeliveryConfig(application, {
        channel,
        destination: trimmed,
        enabled: deliveryEnabled,
      })
      if (!saved) {
        addToast({ type: ToastType.Error, message: 'Failed to save reminder delivery settings.' })
        return
      }
      setChannel(saved.channel)
      setDestination(saved.destination)
      setDeliveryEnabled(saved.enabled)
      addToast({ type: ToastType.Success, message: 'Reminder delivery settings saved.' })
      setPublished(await listPublishedReminders(application))
    } finally {
      setSaving(false)
    }
  }, [application, channel, destination, deliveryEnabled])

  if (!hasAccount) {
    return null
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Reminder delivery</Title>
        <Text className="mb-3">
          When a reminder is due, the server can deliver it over WhatsApp, Telegram, or email. Unlike in-app reminders
          &mdash; which stay end-to-end encrypted in your note &mdash; a reminder delivered this way has its time and
          text sent to the server in plaintext (it leaves end-to-end encryption) so it can be delivered. While delivery
          is enabled below, every reminder you set or update is published to the server for delivery; turn delivery off
          to stop sharing new reminders. Your notes themselves always stay encrypted. Delivery also requires your server
          operator to have enabled and configured this feature. Turning account access off cancels pending deliveries
          when they have not already reached a provider, then erases the server&apos;s published reminder history and
          saved destination.
        </Text>

        {isLoading ? (
          <Spinner className="mt-2 h-4 w-4" />
        ) : !serverEnabled && !optIn ? (
          <Text className="mt-2">Reminder delivery is not enabled on this server.</Text>
        ) : (
          <>
            {!serverEnabled && (
              <Text className="mb-3">
                The operator has disabled new reminder delivery. You can still revoke your existing opt-in and erase its
                server-readable data below.
              </Text>
            )}
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Subtitle>Allow reminder delivery</Subtitle>
                <Text>
                  Turn this off to cancel pending work and erase published reminder text, history, and the saved
                  destination from the server. A delivery already in flight must finish before opt-out can complete.
                </Text>
              </div>
              <Switch onChange={() => void handleToggleOptIn()} checked={optIn} />
            </div>

            {serverEnabled && optIn && (
              <div className="mt-4 flex flex-col gap-3">
                <div className="flex flex-col">
                  <Subtitle>Delivery channel</Subtitle>
                  <div className="mt-1 flex flex-col">
                    {DELIVERY_CHANNELS.map((option) => (
                      <label key={option} className="flex items-center text-sm">
                        <input
                          className="mr-2"
                          type="radio"
                          name="reminder-delivery-channel"
                          checked={channel === option}
                          onChange={() => setChannel(option)}
                          disabled={saving}
                        />
                        {channelLabel(option)}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col">
                  <Subtitle>{destinationLabel(channel)}</Subtitle>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder={destinationPlaceholder(channel)}
                    value={destination}
                    onChange={(value) => {
                      setDestination(value)
                      setDestinationTouched(true)
                    }}
                    disabled={saving}
                  />
                  <Text className="text-passive-0 mt-1">{destinationHint(channel)}</Text>
                  {destinationError && <Text className="text-danger mt-1">{destinationError}</Text>}
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <Subtitle>Enable delivery</Subtitle>
                    <Text>Deliver due reminders you publish to the channel above.</Text>
                  </div>
                  <Switch
                    onChange={() => setDeliveryEnabled((current) => !current)}
                    checked={deliveryEnabled}
                    disabled={saving}
                  />
                </div>

                <div>
                  <Button label="Save" primary disabled={saving} onClick={handleSave} />
                </div>

                <div className="mt-2">
                  <Subtitle>Reminders published for delivery</Subtitle>
                  <Text className="text-passive-0 mb-1">
                    These are the reminders currently shared with the server for delivery.
                  </Text>
                  {published.length === 0 ? (
                    <Text className="mt-1">No reminders have been published for delivery.</Text>
                  ) : (
                    published.map((reminder) => (
                      <div
                        key={reminder.id}
                        className="border-border mt-2 flex flex-row items-center justify-between rounded border border-solid p-3"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="text-base font-medium break-words lg:text-sm">{reminder.message}</span>
                          <span className="text-passive-0 text-sm break-words lg:text-xs">
                            Due: {formatDateTime(reminder.dueAtUtc)}
                          </span>
                          <span className="text-passive-0 text-sm break-words lg:text-xs">
                            {reminder.sent ? 'Delivered' : reminder.error ? `Pending — ${reminder.error}` : 'Pending'}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(ReminderDelivery)
