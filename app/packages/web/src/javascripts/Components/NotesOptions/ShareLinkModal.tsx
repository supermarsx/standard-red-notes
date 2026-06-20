import { useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import { encryptShare } from '../SharedView/shareCrypto'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

const ShareLinkModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
  const [oneTimeView, setOneTimeView] = useState(false)
  const [useExpiry, setUseExpiry] = useState(false)
  const [expiryMinutes, setExpiryMinutes] = useState('15')
  const [submitting, setSubmitting] = useState(false)
  const [createdLink, setCreatedLink] = useState<string | null>(null)

  const parsedMinutes = Number(expiryMinutes)
  const expiryValid = !useExpiry || (Number.isInteger(parsedMinutes) && parsedMinutes > 0)

  const onCreate = useCallback(async () => {
    setSubmitting(true)
    try {
      const { encryptedPayload, keyHex } = await encryptShare({
        kind: 'note',
        title: note.title,
        text: note.text,
      })

      const viewExpiresMinutes = useExpiry ? parsedMinutes : null

      const response = await application.legacyApi.createShare({
        type: 'note',
        encryptedPayload,
        oneTimeView,
        viewExpiresMinutes,
      })

      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create share link.' })
        return
      }

      const shareId = (response as { data?: { shareId?: string } }).data?.shareId
      if (!shareId) {
        addToast({ type: ToastType.Error, message: 'The server did not return a share link.' })
        return
      }

      // The key lives only in the URL fragment and is never sent to the server.
      const link = `${window.location.origin}/?shared=${shareId}#${keyHex}`
      setCreatedLink(link)

      try {
        await navigator?.clipboard?.writeText(link)
        addToast({ type: ToastType.Success, message: 'Share link copied to clipboard.' })
      } catch {
        addToast({ type: ToastType.Regular, message: 'Share link created (copy it below).' })
      }
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create share link.' })
    } finally {
      setSubmitting(false)
    }
  }, [application, note, oneTimeView, useExpiry, parsedMinutes])

  return (
    <Modal
      title="Create share link"
      className="p-4"
      close={close}
      actions={[
        {
          label: createdLink ? 'Done' : 'Cancel',
          type: createdLink ? 'primary' : 'cancel',
          onClick: close,
          mobileSlot: 'left',
        },
        ...(createdLink
          ? []
          : [
              {
                label: submitting ? 'Creating…' : 'Create link',
                type: 'primary' as const,
                onClick: () => void onCreate(),
                disabled: submitting || !expiryValid,
                mobileSlot: 'right' as const,
              },
            ]),
      ]}
    >
      <div className="flex flex-col gap-4">
        {!createdLink && (
          <>
            <div className="rounded border border-solid border-warning bg-warning-faded p-3 text-sm">
              <div className="font-semibold text-warning">Anyone with the link can read this note</div>
              <p className="mt-1">
                A share link is read-only and decrypted in the recipient&rsquo;s browser; the server only stores
                ciphertext and never sees the key (it stays in the link fragment). Anyone who obtains the full link can
                read it.
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={oneTimeView}
                onChange={(event) => setOneTimeView(event.target.checked)}
              />
              <span className="flex flex-col">
                <span className="font-semibold">Burn after reading (one-time view)</span>
                <span className="text-xs text-passive-0">
                  The link stops working as soon as it is first opened. It cannot be reopened.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={useExpiry}
                onChange={(event) => setUseExpiry(event.target.checked)}
              />
              <span className="flex flex-col">
                <span className="font-semibold">Expire after the first open</span>
                <span className="text-xs text-passive-0">
                  Once opened, the link keeps working for this many minutes, then expires.
                </span>
              </span>
            </label>

            {useExpiry && (
              <div className="ml-6 flex flex-col gap-1">
                <label className="text-sm font-semibold">Minutes after first open</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="w-32 rounded border border-border bg-default px-2 py-1.5 text-sm"
                  value={expiryMinutes}
                  onChange={(event) => setExpiryMinutes(event.target.value)}
                />
                {!expiryValid && (
                  <span className="text-xs text-danger">Enter a whole number of minutes greater than zero.</span>
                )}
              </div>
            )}
          </>
        )}

        {createdLink && (
          <div className="flex flex-col gap-2">
            <div className="text-sm">
              Your share link is ready{oneTimeView ? ' and will self-destruct after the first open' : ''}
              {useExpiry ? ` (expires ${parsedMinutes} minute${parsedMinutes === 1 ? '' : 's'} after the first open)` : ''}
              .
            </div>
            <textarea
              readOnly
              className="h-24 w-full resize-none rounded border border-border bg-contrast p-2 text-xs"
              value={createdLink}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="text-xs text-passive-0">
              It has been copied to your clipboard. The decryption key is in the part after the <code>#</code> and never
              reaches the server.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
})

const ShareLinkModal = ({ application, note, isOpen, close }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[34rem]">
      <ShareLinkModalContent application={application} note={note} close={close} />
    </ModalOverlay>
  )
}

export default observer(ShareLinkModal)
