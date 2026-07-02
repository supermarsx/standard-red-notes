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
  channelLabel,
  destinationLabel,
  destinationPlaceholder,
  getDeliveryConfig,
  getReminderDeliveryConfig,
  getReminderDeliveryOptIn,
  setDeliveryConfig,
  setReminderDeliveryOptIn,
  validateDestination,
} from '@/Reminders/reminderDelivery'

type Props = {
  application: WebApplication
}

const ReminderDelivery = ({ application }: Props) => {
  const hasAccount = application.hasAccount()

  const [isLoading, setIsLoading] = useState(false)
  const [serverEnabled, setServerEnabled] = useState(false)
  const [optIn, setOptIn] = useState(false)

  const [channel, setChannel] = useState<DeliveryChannel>('whatsapp')
  const [destination, setDestination] = useState('')
  const [deliveryEnabled, setDeliveryEnabled] = useState(false)
  const [saving, setSaving] = useState(false)

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
        const delivery = await getDeliveryConfig(application)
        if (delivery) {
          setChannel(delivery.channel)
          setDestination(delivery.destination)
          setDeliveryEnabled(delivery.enabled)
        }
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
          When a reminder you have opted in is due, the server can deliver it over WhatsApp, Telegram, or
          email. Unlike in-app reminders &mdash; which stay end-to-end encrypted in your note &mdash; a
          reminder delivered this way has its time, text, and destination sent to the server in plaintext
          (it leaves end-to-end encryption) so it can be delivered. Only reminders you explicitly opt in
          are shared.
        </Text>

        {isLoading ? (
          <Spinner className="mt-2 h-4 w-4" />
        ) : !serverEnabled ? (
          <Text className="mt-2">Reminder delivery is not enabled on this server.</Text>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Subtitle>Allow reminder delivery</Subtitle>
                <Text>Turn this off to stop the server from delivering any of your reminders.</Text>
              </div>
              <Switch onChange={() => void handleToggleOptIn()} checked={optIn} />
            </div>

            {optIn && (
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
                    onChange={(value) => setDestination(value)}
                    disabled={saving}
                  />
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
              </div>
            )}
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(ReminderDelivery)
