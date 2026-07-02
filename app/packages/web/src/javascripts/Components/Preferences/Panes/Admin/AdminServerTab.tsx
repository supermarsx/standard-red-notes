import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Switch from '@/Components/Switch/Switch'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

const AdminServerTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  // Instance-wide switches. Loaded lazily: this component only mounts when the
  // Server tab is opened.
  const [registrationDisabled, setRegistrationDisabled] = useState(false)
  const [registrationLoading, setRegistrationLoading] = useState(false)

  const loadRegistrationFlag = useCallback(async () => {
    setRegistrationLoading(true)
    try {
      const response = await application.legacyApi.adminGetRegistrationFlag()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { registrationDisabled?: boolean } }).data
        setRegistrationDisabled(Boolean(data?.registrationDisabled))
      } else {
        noteIfForbidden(response)
      }
    } catch (error) {
      console.error(error)
    } finally {
      setRegistrationLoading(false)
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadRegistrationFlag()
  }, [loadRegistrationFlag])

  const toggleRegistration = useCallback(
    async (nextValue: boolean) => {
      const previous = registrationDisabled
      setRegistrationDisabled(nextValue)
      try {
        const response = await application.legacyApi.adminSetRegistrationFlag(nextValue)
        if (isErrorResponse(response)) {
          setRegistrationDisabled(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
        }
      } catch (error) {
        console.error(error)
        setRegistrationDisabled(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
      }
    },
    [application, registrationDisabled],
  )

  return (
    <PreferencesSegment>
      <Title>Registration</Title>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <Subtitle>Disable new signups</Subtitle>
          <Text>
            When enabled, new users cannot register on this instance. Note: enforcement at signup currently also depends
            on the server's DISABLE_USER_REGISTRATION configuration.
          </Text>
        </div>
        {registrationLoading ? (
          <Spinner className="h-5 w-5" />
        ) : (
          <Switch checked={registrationDisabled} onChange={(checked) => void toggleRegistration(checked)} />
        )}
      </div>
    </PreferencesSegment>
  )
}

export default AdminServerTab
