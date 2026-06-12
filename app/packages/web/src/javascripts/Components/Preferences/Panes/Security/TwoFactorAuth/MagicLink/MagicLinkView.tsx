import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'

import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import { Title, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import { WebApplication } from '@/Application/WebApplication'
import Switch from '@/Components/Switch/Switch'

type Props = {
  application: WebApplication
}

const MagicLinkView: FunctionComponent<Props> = ({ application }) => {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadStatus = useCallback(async () => {
    try {
      const isEnabled = await application.mfa.isMagicLinkEnabled()
      setEnabled(isEnabled)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    loadStatus().catch(console.error)
  }, [loadStatus])

  const handleToggle = useCallback(
    async (newValue: boolean) => {
      setError('')
      const previous = enabled
      setEnabled(newValue)
      try {
        await application.mfa.setMagicLinkEnabled(newValue)
      } catch (e) {
        setEnabled(previous)
        setError((e as Error).message)
      }
    },
    [application, enabled],
  )

  if (application.sessions.getUser() === undefined) {
    return null
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <div className="flex flex-row items-center">
          <div className="flex flex-grow flex-col">
            <Title>Magic link</Title>
            <Text>
              Receive a one-time verification code by email when signing in. If email is not configured on your
              server, the code is shown on screen as a fallback.
            </Text>
          </div>
          <Switch
            checked={enabled}
            disabled={loading}
            onChange={(checked) => {
              handleToggle(checked).catch(console.error)
            }}
          />
        </div>
        {error && <Text className="mt-2 text-danger">{error}</Text>}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(MagicLinkView)
