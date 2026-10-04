import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { SettingName } from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { SmallText, Subtitle, Title } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

type Props = {
  application: WebApplication
}

/**
 * What the account's ceiling is, kept separate from the number itself so that
 * "this deployment publishes no per-account ceiling" (∞) is never confused with
 * "the ceiling was asked for and the server answered nothing".
 */
type Allowance = { kind: 'unbounded' } | { kind: 'unreported' } | { kind: 'bytes'; value: number }

type QuotaReading =
  | { state: 'loading' }
  | { state: 'failed'; detail: string }
  /** The request succeeded and the server carried no usage figure. */
  | { state: 'unreported' }
  | { state: 'read'; usedBytes: number; allowance: Allowance }

function parseByteSetting(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = parseFloat(value)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function describeReadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const trimmed = message.trim()

  return trimmed.length > 0 ? trimmed.slice(0, 200) : 'The server did not answer the request.'
}

/**
 * Standard Red Notes: the account's FILE storage quota.
 *
 * This pane used to have one state for three different answers, and the two
 * failures were both invisible:
 *
 *   - `getSubscriptionSetting` resolves `undefined` when the server has no
 *     FILE_UPLOAD_BYTES_USED figure for this account (it answers 400 for an
 *     account with no subscription record, and `SettingsGateway` maps that to
 *     `undefined`). The old code left its `0` initial state in place, so "the
 *     server reported nothing" rendered as the measured figure `0 B` — the
 *     reading a user reads as "my account holds no files".
 *   - Any OTHER failure (network failure, 401, 500) makes that call THROW. The
 *     old `getFilesQuota().catch(console.error)` swallowed it after
 *     `setIsLoading(false)` had become unreachable, so the pane kept its
 *     spinner for the lifetime of the tab with nothing on screen saying why.
 *
 * So the three outcomes are now three distinct renders, and the absent reading
 * states the evidence it is drawn from rather than asserting a quantity:
 * `failed` says the read failed and offers a retry, `unreported` says the
 * server returned no figure, and `read` prints figures.
 */
const FilesSection: FunctionComponent<Props> = ({ application }) => {
  const [reading, setReading] = useState<QuotaReading>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    const readQuota = async (): Promise<QuotaReading> => {
      const usedSetting = await application.settings.getSubscriptionSetting(
        SettingName.create(SettingName.NAMES.FileUploadBytesUsed).getValue(),
      )
      const usedBytes = parseByteSetting(usedSetting)

      if (usedBytes === undefined) {
        return { state: 'unreported' }
      }

      // A non-first-party server does not publish a per-account ceiling; the
      // existing copy reports that as an unbounded allowance rather than
      // inventing a limit.
      if (!application.sessions.isSignedIntoFirstPartyServer()) {
        return { state: 'read', usedBytes, allowance: { kind: 'unbounded' } }
      }

      const totalSetting = await application.settings.getSubscriptionSetting(
        SettingName.create(SettingName.NAMES.FileUploadBytesLimit).getValue(),
      )
      const totalBytes = parseByteSetting(totalSetting)

      return {
        state: 'read',
        usedBytes,
        allowance: totalBytes === undefined ? { kind: 'unreported' } : { kind: 'bytes', value: totalBytes },
      }
    }

    setReading({ state: 'loading' })

    readQuota().then(
      (result) => {
        if (!cancelled) {
          setReading(result)
        }
      },
      (error: unknown) => {
        console.error(error)
        if (!cancelled) {
          setReading({ state: 'failed', detail: describeReadFailure(error) })
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [application, attempt])

  const retry = useCallback(() => {
    setAttempt((current) => current + 1)
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Files</Title>
        <Subtitle>Storage Quota</Subtitle>
        {reading.state === 'loading' && (
          <div className="mt-2">
            <Spinner className="h-3 w-3" />
          </div>
        )}
        {reading.state === 'failed' && (
          <>
            <div className="mt-1 mb-1 font-semibold">Could not read your file storage usage.</div>
            <SmallText className="mb-2">{reading.detail}</SmallText>
            <Button small onClick={retry}>
              Try again
            </Button>
          </>
        )}
        {reading.state === 'unreported' && (
          <>
            <div className="mt-1 mb-1 font-semibold">Not reported by the server</div>
            <SmallText className="mb-2">
              Your server returned no FILE_UPLOAD_BYTES_USED figure for this account, so this is not a measured zero. It
              appears once the server records file usage for the account.
            </SmallText>
            <Button small onClick={retry}>
              Try again
            </Button>
          </>
        )}
        {reading.state === 'read' && (
          <>
            <div className="mt-1 mb-1">
              <span className="font-semibold">{formatSizeToReadableString(reading.usedBytes)}</span> of{' '}
              <span>
                {reading.allowance.kind === 'bytes'
                  ? formatSizeToReadableString(reading.allowance.value)
                  : reading.allowance.kind === 'unbounded'
                    ? '∞'
                    : 'an allowance the server did not report'}
              </span>{' '}
              used
            </div>
            {reading.allowance.kind === 'bytes' && reading.allowance.value > 0 && (
              <progress
                className="progress-bar w-full"
                aria-label="Files storage used"
                value={reading.usedBytes}
                max={reading.allowance.value}
              />
            )}
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default FilesSection
