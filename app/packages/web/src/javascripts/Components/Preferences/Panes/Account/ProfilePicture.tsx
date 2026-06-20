import { ChangeEvent, FunctionComponent, useCallback, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import Avatar from '@/Avatar/Avatar'
import { processAndStoreAvatar, removeStoredAvatar } from '@/Avatar/avatarService'
import { useStoredAvatar } from '@/Avatar/useStoredAvatar'
import { ACCEPTED_IMAGE_TYPES } from '@/Avatar/avatarCore'
import { Subtitle, Text, Title, SmallText } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { c } from 'ttag'

type Props = {
  application: WebApplication
}

const ProfilePicture: FunctionComponent<Props> = ({ application }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const avatar = useStoredAvatar(application)
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  const user = application.sessions.getUser()
  const email = user?.email

  const onPickClick = useCallback(() => {
    setError(null)
    inputRef.current?.click()
  }, [])

  const onFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Allow re-picking the same file later.
      event.target.value = ''
      if (!file) {
        return
      }
      setError(null)
      setIsProcessing(true)
      try {
        await processAndStoreAvatar(application, file)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not set the profile picture.')
      } finally {
        setIsProcessing(false)
      }
    },
    [application],
  )

  const onRemove = useCallback(() => {
    setError(null)
    removeStoredAvatar(application)
  }, [application])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>{c('Title').t`Profile picture`}</Title>
        <Text>{c('Info')
          .t`Set a profile picture shown on your account menu and here. It defaults to your initials when none is set.`}</Text>

        <div className="mt-3 flex items-center gap-4">
          <Avatar email={email} size={64} className="border border-border" />
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                label={avatar ? c('Action').t`Change photo` : c('Action').t`Upload photo`}
                onClick={onPickClick}
                disabled={isProcessing}
              />
              {avatar && (
                <Button label={c('Action').t`Remove photo`} onClick={onRemove} disabled={isProcessing} />
              )}
            </div>
            <Subtitle className="m-0">
              {isProcessing ? c('Status').t`Processing image…` : c('Info').t`PNG, JPEG, WebP or GIF, up to 10 MB.`}
            </Subtitle>
          </div>
        </div>

        {error && <Text className="mt-2 text-danger">{error}</Text>}

        <SmallText className="mt-3 text-passive-0">
          {c('Info')
            .t`Your profile picture is stored locally on this device only and is not synced across devices.`}
        </SmallText>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          className="hidden"
          onChange={onFileSelected}
        />
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(ProfilePicture)
