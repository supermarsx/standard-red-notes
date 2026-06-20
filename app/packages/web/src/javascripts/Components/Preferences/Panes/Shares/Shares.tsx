import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
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
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Share Links</Title>
        <Text>
          Share links let anyone with the URL read a note (or tag bundle) without an account. The content is encrypted
          in your browser under a secret key that lives only in the link's fragment and is never sent to the server —
          the server stores only ciphertext. Revoke a link any time to immediately cut off access.
        </Text>

        <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
          <Subtitle className="text-warning">Anyone with the link can read the shared content</Subtitle>
          <Text className="mt-1">
            A share link removes end-to-end encryption for whatever you share: anyone who has the full URL can read it,
            and it can be forwarded or leaked beyond who you intended. The encrypted content and the link itself live on
            the server, which mediates every view. The server cannot decrypt the content on its own (the key stays in
            the link), but anyone who obtains the full link can. Only share content you are comfortable exposing this
            way, and revoke the link to immediately cut off access.
          </Text>
        </div>

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
              className="mt-2 flex flex-col gap-2 rounded border border-solid border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <span className="break-words text-base font-medium lg:text-sm">
                  {share.nickname || `${share.type} share`}
                </span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  {share.type} · {share.revoked ? 'Revoked' : 'Active'}
                </span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  Created {formatDate(share.createdAt)}
                </span>
              </div>
              {!share.revoked && (
                <Button className="flex-shrink-0" label="Revoke" onClick={() => handleRevoke(share.uuid)} />
              )}
            </div>
          ))}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Shares)
