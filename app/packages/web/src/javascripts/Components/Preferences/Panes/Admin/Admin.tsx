import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'

type Props = {
  application: WebApplication
}

type LookedUpUser = {
  uuid: string
  email: string
}

// Server-only Standard Red Notes setting names. The client's published
// domain-core does not carry these, so use the literal strings the server
// expects (must match the server's SettingName.NAMES values exactly).
const AI_ENABLED = 'AI_ENABLED'
const AI_REQUEST_LIMIT = 'AI_REQUEST_LIMIT'

const Admin: FunctionComponent<Props> = ({ application }: Props) => {
  const isAdmin = application.featuresController.isAdminUser()

  const [email, setEmail] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [user, setUser] = useState<LookedUpUser | undefined>(undefined)

  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiRequestLimit, setAiRequestLimit] = useState('')
  const [flagsLoading, setFlagsLoading] = useState(false)
  const [savingLimit, setSavingLimit] = useState(false)

  const [registrationDisabled, setRegistrationDisabled] = useState(false)
  const [registrationLoading, setRegistrationLoading] = useState(false)

  const loadRegistrationFlag = useCallback(async () => {
    if (!isAdmin) {
      return
    }
    setRegistrationLoading(true)
    try {
      const response = await application.legacyApi.adminGetRegistrationFlag()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { registrationDisabled?: boolean } }).data
        setRegistrationDisabled(Boolean(data?.registrationDisabled))
      }
    } catch (error) {
      console.error(error)
    } finally {
      setRegistrationLoading(false)
    }
  }, [application, isAdmin])

  useEffect(() => {
    void loadRegistrationFlag()
  }, [loadRegistrationFlag])

  const loadFlags = useCallback(
    async (userUuid: string) => {
      setFlagsLoading(true)
      try {
        const response = await application.legacyApi.adminGetUserFeatureFlags(userUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to load user feature flags.' })
          return
        }
        const data = (response as { data?: { flags?: Record<string, string | null> } }).data
        const flags = data?.flags ?? {}
        setAiEnabled(flags[AI_ENABLED] === 'true')
        setAiRequestLimit(flags[AI_REQUEST_LIMIT] ?? '')
      } catch (error) {
        console.error(error)
      } finally {
        setFlagsLoading(false)
      }
    },
    [application],
  )

  const lookupUser = useCallback(async () => {
    if (!email.trim()) {
      return
    }
    setLookingUp(true)
    setUser(undefined)
    try {
      const response = await application.legacyApi.adminLookupUser(email.trim())
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      const data = (response as { data?: { uuid?: string } }).data
      if (!data?.uuid) {
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      const lookedUp = { uuid: data.uuid, email: email.trim() }
      setUser(lookedUp)
      await loadFlags(lookedUp.uuid)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to look up user.' })
    } finally {
      setLookingUp(false)
    }
  }, [application, email, loadFlags])

  const toggleAiEnabled = useCallback(
    async (nextValue: boolean) => {
      if (!user) {
        return
      }
      const previous = aiEnabled
      setAiEnabled(nextValue)
      try {
        const response = await application.legacyApi.adminSetUserFeatureFlag(
          user.uuid,
          AI_ENABLED,
          nextValue ? 'true' : 'false',
        )
        if (isErrorResponse(response)) {
          setAiEnabled(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update AI access.' })
        }
      } catch (error) {
        console.error(error)
        setAiEnabled(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update AI access.' })
      }
    },
    [application, user, aiEnabled],
  )

  const saveRequestLimit = useCallback(async () => {
    if (!user) {
      return
    }
    setSavingLimit(true)
    try {
      const response = await application.legacyApi.adminSetUserFeatureFlag(
        user.uuid,
        AI_REQUEST_LIMIT,
        aiRequestLimit.trim() === '' ? null : aiRequestLimit.trim(),
      )
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to update AI request limit.' })
        return
      }
      addToast({ type: ToastType.Success, message: 'AI request limit saved.' })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to update AI request limit.' })
    } finally {
      setSavingLimit(false)
    }
  }, [application, user, aiRequestLimit])

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

  if (!isAdmin) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Admin</Title>
            <Text>
              You do not have administrator access. This panel is only available to users with the internal team role.
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Administrator</Title>
          <Text>
            You are signed in with the internal team (admin) role. Use the tools below to manage other users' access to
            AI features and to control whether new signups are allowed. All actions are re-verified against your role on
            the server.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Manage user AI access</Title>
          <Subtitle>Look up a user by email to manage their per-user feature flags.</Subtitle>
          <div className="mt-3 flex items-center gap-3">
            <DecoratedInput
              className={{ container: 'flex-grow' }}
              placeholder="user@example.com"
              value={email}
              onChange={setEmail}
              onEnter={() => void lookupUser()}
              type="email"
            />
            <Button label="Look up" onClick={() => void lookupUser()} disabled={lookingUp} />
          </div>
          {lookingUp && <Spinner className="mt-3 h-5 w-5" />}

          {user && (
            <div className="mt-4">
              <HorizontalSeparator classes="my-3" />
              <Subtitle>
                Editing: {user.email} ({user.uuid})
              </Subtitle>

              {flagsLoading ? (
                <Spinner className="mt-3 h-5 w-5" />
              ) : (
                <>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>AI access</Subtitle>
                      <Text>Allow this user to use AI-powered features.</Text>
                    </div>
                    <Switch checked={aiEnabled} onChange={(checked) => void toggleAiEnabled(checked)} />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex flex-col gap-2">
                    <Subtitle>AI request / token limit</Subtitle>
                    <Text>Maximum number of AI requests/tokens allowed for this user. Leave blank for no limit.</Text>
                    <div className="mt-1 flex items-center gap-3">
                      <DecoratedInput
                        className={{ container: 'w-40' }}
                        placeholder="e.g. 1000"
                        value={aiRequestLimit}
                        onChange={setAiRequestLimit}
                        type="number"
                      />
                      <Button label="Save limit" onClick={() => void saveRequestLimit()} disabled={savingLimit} />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Registration</Title>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <Subtitle>Disable new signups</Subtitle>
              <Text>
                When enabled, new users cannot register on this instance. Note: enforcement at signup currently also
                depends on the server's DISABLE_USER_REGISTRATION configuration.
              </Text>
            </div>
            {registrationLoading ? (
              <Spinner className="h-5 w-5" />
            ) : (
              <Switch
                checked={registrationDisabled}
                onChange={(checked) => void toggleRegistration(checked)}
              />
            )}
          </div>
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Admin)
