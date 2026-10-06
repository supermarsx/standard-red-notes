import { useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SNNote, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'
import { fallbackCopyTextToClipboard } from '@/Utils/copyTextToClipboard'
import Modal from '../Modal/Modal'
import ModalOverlay from '../Modal/ModalOverlay'
import { encryptShare } from '../SharedView/shareCrypto'
import {
  createApplicationShareAssetSource,
  inlineShareAssets,
  shareAssetPlaceholderText,
  ShareAssetOmission,
} from '../SharedView/shareAssets'

type Props = {
  application: WebApplication
  note: SNNote
  isOpen: boolean
  close: () => void
}

/**
 * Copy the share link and report whether it ACTUALLY reached the clipboard.
 *
 * `navigator.clipboard` exists only in a secure context. The previous code wrote
 * `await navigator?.clipboard?.writeText(link)` — optional chaining, so where the
 * Clipboard API is absent the whole expression short-circuits to `undefined`,
 * nothing throws, and the `catch` that was meant to report the failure never
 * runs. Measured in Chrome with `navigator.clipboard` deleted: the modal said
 * "Share link copied to clipboard." and the panel repeated the claim, having
 * copied nothing at all.
 *
 * So presence is checked explicitly, and the shared `execCommand`-based fallback
 * (which needs no Clipboard API and mounts its own detached textarea, so it also
 * works before the link field has rendered) is tried before giving up.
 */
const copyShareLink = async (link: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(link)
      return true
    } catch {
      // Permission denied / not focused: fall through to the fallback below.
    }
  }

  return fallbackCopyTextToClipboard(link)
}

const ShareLinkModalContent = observer(({ application, note, close }: Omit<Props, 'isOpen'>) => {
  const [oneTimeView, setOneTimeView] = useState(false)
  const [useExpiry, setUseExpiry] = useState(false)
  const [expiryMinutes, setExpiryMinutes] = useState('15')
  const [submitting, setSubmitting] = useState(false)
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  // What actually travelled with the link. A share that quietly dropped an
  // image leaves the author believing the reader can see it, so the counts and
  // the per-file reasons are reported here as well as on the reader's page.
  const [assetReport, setAssetReport] = useState<{ inlined: number; omitted: ShareAssetOmission[] } | null>(null)
  // Whether the link genuinely reached the clipboard. The panel below used to
  // assert it unconditionally, which is false whenever the copy did not happen.
  const [copied, setCopied] = useState(false)

  const parsedMinutes = Number(expiryMinutes)
  const expiryValid = !useExpiry || (Number.isInteger(parsedMinutes) && parsedMinutes > 0)

  const onCreate = useCallback(async () => {
    setSubmitting(true)
    try {
      // A share link has no session, so an embedded file's bytes are
      // unreachable from the reader's browser (both `/v1/files` and the
      // valet-token mint answer 401 without one) and its key was never in the
      // envelope. Inline the images HERE, while the owner still holds both, and
      // leave a visible placeholder for anything that could not come along.
      const assets = await inlineShareAssets(note.text, createApplicationShareAssetSource(application))
      setAssetReport({ inlined: assets.inlined, omitted: assets.omitted })

      const { encryptedPayload, keyHex } = await encryptShare({
        kind: 'note',
        title: note.title,
        text: assets.text,
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

      const didCopy = await copyShareLink(link)
      setCopied(didCopy)
      addToast(
        didCopy
          ? { type: ToastType.Success, message: 'Share link copied to clipboard.' }
          : { type: ToastType.Regular, message: 'Share link created — copy it below.' },
      )
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
            <div className="border-warning bg-warning-faded rounded border border-solid p-3 text-sm">
              <div className="text-warning font-semibold">Anyone with the link can read this note</div>
              <p className="mt-1">
                A share link is read-only and decrypted in the recipient&rsquo;s browser; the server only stores
                ciphertext and never sees the key (it stays in the link fragment). Anyone who obtains the full link can
                read it.
              </p>
              <p className="mt-1">
                Images embedded in this note are <strong>copied into the link</strong> so they display without an
                account. Other attachments are not, and the reader is shown a note saying so where each one sits.
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
                <span className="text-passive-0 text-xs">
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
                <span className="text-passive-0 text-xs">
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
                  className="border-border bg-default w-32 rounded border px-2 py-1.5 text-sm"
                  value={expiryMinutes}
                  onChange={(event) => setExpiryMinutes(event.target.value)}
                />
                {!expiryValid && (
                  <span className="text-danger text-xs">Enter a whole number of minutes greater than zero.</span>
                )}
              </div>
            )}
          </>
        )}

        {createdLink && assetReport !== null && (assetReport.inlined > 0 || assetReport.omitted.length > 0) && (
          <div
            className="border-border rounded border border-solid p-3 text-xs"
            data-share-asset-report={`${assetReport.inlined}/${assetReport.omitted.length}`}
          >
            <div className="font-semibold">
              {assetReport.inlined} embedded {assetReport.inlined === 1 ? 'image' : 'images'} travelled with this link
              {assetReport.omitted.length > 0 ? `; ${assetReport.omitted.length} did not` : ''}.
            </div>
            {assetReport.omitted.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {assetReport.omitted.map((omission, index) => (
                  <li key={`${omission.fileUuid}-${index}`}>{shareAssetPlaceholderText(omission)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {createdLink && (
          <div className="flex flex-col gap-2">
            <div className="text-sm">
              Your share link is ready{oneTimeView ? ' and will self-destruct after the first open' : ''}
              {useExpiry
                ? ` (expires ${parsedMinutes} minute${parsedMinutes === 1 ? '' : 's'} after the first open)`
                : ''}
              .
            </div>
            <textarea
              readOnly
              className="border-border bg-contrast h-24 w-full resize-none rounded border p-2 text-xs"
              value={createdLink}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="border-border bg-default hover:bg-contrast self-start rounded border px-3 py-1.5 text-sm"
              onClick={() => {
                void copyShareLink(createdLink).then((didCopy) => {
                  setCopied(didCopy)
                  addToast(
                    didCopy
                      ? { type: ToastType.Success, message: 'Share link copied to clipboard.' }
                      : { type: ToastType.Error, message: 'Could not copy — select the link above and copy it.' },
                  )
                })
              }}
            >
              Copy link
            </button>
            <div className="text-passive-0 text-xs">
              {copied
                ? 'It has been copied to your clipboard. '
                : 'It was NOT copied to your clipboard — select the whole link above, or use Copy link. '}
              The decryption key is the part after the <code>#</code>; a link without it cannot be opened, and it never
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
