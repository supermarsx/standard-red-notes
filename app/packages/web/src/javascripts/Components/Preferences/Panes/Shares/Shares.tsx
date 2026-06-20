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
import Spinner from '@/Components/Spinner/Spinner'

type Props = {
  application: WebApplication
}

type Share = {
  uuid: string
  type: string
  nickname: string | null
  createdAt: string
  revoked: boolean
}

const formatDate = (value: string | null): string => {
  if (!value) {
    return 'Unknown'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const Shares: FunctionComponent<Props> = ({ application }: Props) => {
  const [shares, setShares] = useState<Share[]>([])
  const [loading, setLoading] = useState(false)

  const loadShares = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listShares()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { shares?: Share[] } }).data
        setShares(data?.shares ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadShares()
  }, [loadShares])

  const handleRevoke = useCallback(
    async (shareId: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to revoke this share link? Anyone holding the link will immediately lose access.',
        'Revoke Share Link',
        'Revoke',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.revokeShare(shareId)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke share link.' })
          return
        }
        await loadShares()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke share link.' })
      }
    },
    [application, loadShares],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Share Links</Title>
        <Text>
          Share links let anyone with the URL read a note (or tag bundle) without an account. The content is encrypted
          in your browser under a secret key that lives only in the link's fragment and is never sent to the server —
          the server stores only ciphertext. Revoke a link any time to immediately cut off access.
        </Text>
        <Text className="mt-2">
          Create a share link from a note's options menu ("Create share link"). Manage and revoke your existing links
          below.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Your share links</Subtitle>
        {loading && <Spinner className="mt-2 h-4 w-4" />}
        {!loading && shares.length === 0 && <Text className="mt-2">You have no share links.</Text>}
        {!loading &&
          shares.map((share) => (
            <div
              key={share.uuid}
              className="mt-2 flex flex-row items-center justify-between rounded border border-solid border-border p-3"
            >
              <div className="flex flex-col">
                <span className="text-base font-medium lg:text-sm">{share.nickname || `${share.type} share`}</span>
                <span className="text-sm text-passive-0 lg:text-xs">
                  {share.type} · {share.revoked ? 'Revoked' : 'Active'}
                </span>
                <span className="text-sm text-passive-0 lg:text-xs">Created {formatDate(share.createdAt)}</span>
              </div>
              {!share.revoked && <Button label="Revoke" onClick={() => handleRevoke(share.uuid)} />}
            </div>
          ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(Shares)
