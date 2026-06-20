import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Spinner from '@/Components/Spinner/Spinner'
import Switch from '@/Components/Switch/Switch'
import Button from '@/Components/Button/Button'
import {
  ServerEmailReminder,
  deleteEmailReminder,
  getEmailRemindersOptIn,
  listEmailReminders,
  setEmailRemindersOptIn,
} from '@/Reminders/emailReminders'

type Props = {
  application: WebApplication
}

const formatDateTime = (ms: number): string => {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const EmailReminders = ({ application }: Props) => {
  const hasAccount = application.hasAccount()
  const [isLoading, setIsLoading] = useState(false)
  const [optIn, setOptIn] = useState(false)
  const [reminders, setReminders] = useState<ServerEmailReminder[]>([])

  const load = useCallback(async () => {
    if (!hasAccount) {
      return
    }
    setIsLoading(true)
    try {
      const [optInValue, list] = await Promise.all([
        getEmailRemindersOptIn(application),
        listEmailReminders(application),
      ])
      setOptIn(optInValue)
      setReminders(list)
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
    const ok = await setEmailRemindersOptIn(application, next)
    if (!ok) {
      setOptIn(!next)
    }
  }, [application, optIn])

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await deleteEmailReminder(application, id)
      if (ok) {
        setReminders((current) => current.filter((reminder) => reminder.uuid !== id))
      }
    },
    [application],
  )

  if (!hasAccount) {
    return null
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Email reminders</Title>
        <Text className="mb-3">
          When a reminder you have opted in is due, the server can email it to your account email.
          Unlike in-app reminders &mdash; which stay end-to-end encrypted in your note &mdash; a
          reminder you opt into emailing has its time and text sent to the server in plaintext (it
          leaves end-to-end encryption) so it can be delivered. Only reminders you explicitly opt in
          are shared. Emails are sent only if your server operator has enabled and configured email
          reminders.
        </Text>

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Subtitle>Allow email reminders</Subtitle>
            <Text>Turn this off to stop the server from emailing any of your reminders.</Text>
          </div>
          <Switch onChange={() => void handleToggleOptIn()} checked={optIn} />
        </div>

        <div className="mt-4">
          <Subtitle>Your email reminders</Subtitle>
          {isLoading ? (
            <Spinner className="mt-2 h-4 w-4" />
          ) : reminders.length === 0 ? (
            <Text className="mt-2">You have no reminders registered for email.</Text>
          ) : (
            reminders.map((reminder) => (
              <div
                key={reminder.uuid}
                className="mt-2 flex flex-row items-center justify-between rounded border border-solid border-border p-3"
              >
                <div className="flex flex-col">
                  <span className="text-base font-medium lg:text-sm">{reminder.message}</span>
                  <span className="text-sm text-passive-0 lg:text-xs">
                    Due: {formatDateTime(reminder.dueAt)}
                  </span>
                  <span className="text-sm text-passive-0 lg:text-xs">
                    {reminder.sent ? 'Sent' : 'Pending'}
                  </span>
                </div>
                <Button label="Cancel" onClick={() => void handleDelete(reminder.uuid)} />
              </div>
            ))
          )}
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(EmailReminders)
