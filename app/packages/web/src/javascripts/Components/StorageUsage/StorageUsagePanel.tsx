import type { WebApplication } from '@/Application/WebApplication'
import { isErrorResponse, type AccountStorageUsage } from '@standardnotes/snjs'
import { useEffect, useRef, useState } from 'react'
import Button from '@/Components/Button/Button'
import { presentStorageUsage } from './storageUsage'

type Queue = { active: number; pending: Array<() => void> }
const queues = new WeakMap<WebApplication, Queue>()
/** At most four storage measurements per application; offscreen rows never enqueue. */
function schedule<T>(application: WebApplication, run: () => Promise<T>): Promise<T> {
  let queue = queues.get(application)
  if (!queue) {
    queue = { active: 0, pending: [] }
    queues.set(application, queue)
  }
  const current = queue
  return new Promise((resolve, reject) => {
    const start = () => {
      current.active++
      void run()
        .then(resolve, reject)
        .finally(() => {
          current.active--
          current.pending.shift()?.()
        })
    }
    if (current.active < 4) {
      start()
    } else {
      current.pending.push(start)
    }
  })
}

const StorageUsagePanel = ({
  application,
  userUuid,
  compact = false,
  lazy = false,
  noteIfForbidden,
  refreshRevision = 0,
}: {
  application: WebApplication
  userUuid?: string
  compact?: boolean
  lazy?: boolean
  noteIfForbidden?: (response: { status?: number }) => void
  refreshRevision?: number
}) => {
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!lazy)
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ owner?: string; subject?: string; usage: AccountStorageUsage }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const owner = application.sessions.getUser()?.uuid
  useEffect(() => {
    if (!lazy || !element.current || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '0px' },
    )
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [lazy, userUuid])
  useEffect(() => {
    if (!visible) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    void schedule(application, async () => {
      if (cancelled || application.sessions.getUser()?.uuid !== owner) {
        return undefined
      }
      return userUuid
        ? application.legacyApi.adminGetUserStorageUsage(userUuid)
        : application.legacyApi.getAccountStorageUsage()
    })
      .then((response) => {
        if (cancelled || !response || application.sessions.getUser()?.uuid !== owner) {
          return
        }
        noteIfForbidden?.(response)
        if (isErrorResponse(response) || !response.data) {
          setSnapshot(undefined)
          setError('Storage usage could not be measured.')
          return
        }
        setSnapshot({ owner, subject: userUuid, usage: response.data })
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshot(undefined)
          setError('Storage usage could not be measured.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [application, userUuid, owner, visible, revision, refreshRevision, noteIfForbidden])
  const reading =
    snapshot?.owner === owner && snapshot?.subject === userUuid && snapshot?.usage
      ? presentStorageUsage(snapshot.usage)
      : undefined
  return (
    <div
      ref={element}
      aria-label={compact ? 'Storage usage' : 'Account storage usage'}
      className={compact ? 'text-xs' : 'my-3'}
    >
      {!compact && <h3 className="font-semibold">Space used</h3>}
      {loading && <p role="status">Measuring storage…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {reading && (
        <>
          <div data-test-id={compact ? 'admin-row-space-total' : 'storage-total'}>
            Total: <strong>{reading.total}</strong>
          </div>
          <dl className={compact ? 'text-passive-1' : 'mt-2 grid grid-cols-2 gap-1'}>
            {reading.parts.map((part) => (
              <div
                key={part.key}
                data-test-id={compact ? `admin-row-${part.key}` : undefined}
                className={compact ? '' : 'contents'}
              >
                <dt>{part.label}</dt>
                <dd>
                  {part.text}
                  {part.count !== undefined && !compact ? ` · ${part.count.toLocaleString()} records` : ''}
                </dd>
              </div>
            ))}
          </dl>
          {!reading.complete && (
            <p className="text-passive-1 text-xs">
              Some storage could not be measured. The total is unavailable until all three components are measured.
            </p>
          )}
        </>
      )}
      {!visible && <p className="text-passive-1">Not measured yet</p>}
      <Button
        small
        label={
          !visible
            ? 'Read storage usage'
            : error || reading?.complete === false
              ? 'Retry storage measurement'
              : 'Refresh storage usage'
        }
        disabled={loading}
        onClick={() => {
          setVisible(true)
          setRevision((value) => value + 1)
        }}
      />
      {!compact && (
        <>
          {reading && (
            <p className="text-passive-1 mt-2 text-xs">
              Measurement time:{' '}
              {snapshot?.usage.measuredAt && Number.isFinite(Date.parse(snapshot.usage.measuredAt))
                ? new Date(snapshot.usage.measuredAt).toLocaleString()
                : 'Unavailable'}
            </p>
          )}
          <p className="text-passive-1 mt-2 text-xs">
            Encrypted items include notes and other stored item metadata. Uploaded file data and saved note revisions
            are counted separately. Upload quota applies to files separately.
          </p>
        </>
      )}
    </div>
  )
}

export default StorageUsagePanel
