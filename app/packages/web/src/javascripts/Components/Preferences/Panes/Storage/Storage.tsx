import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { estimateStorage, formatBytes, StorageEstimateResult } from '@/Utils/StorageQuota'
import { isStorageUsageScanAvailable, scanStorageUsage } from '@/Utils/Storage/StorageUsageManager'
import { StorageUsageSnapshot } from '@/Utils/Storage/storageUsageWorkerProtocol'
import { contentTypeLabel, loadCachedSnapshot, percentOf, saveCachedSnapshot } from './storageDisplay'

type Props = {
  application: WebApplication
}

const sortBucketsBySize = (snapshot: StorageUsageSnapshot) =>
  [...snapshot.buckets].sort((a, b) => b.bytes - a.bytes)

/**
 * Standard Red Notes: Storage pane. Shows where local disk space goes:
 *  - Total used + quota (StorageQuota.estimateStorage) with a usage bar.
 *  - A breakdown of measured IndexedDB bytes per content type.
 *  - The largest stored entries (top-N).
 *
 * All sizing is computed OFF the main thread by storageUsage.worker.ts via
 * StorageUsageManager: the worker cursors the encrypted IndexedDB entries read-only
 * and streams progressive snapshots, so the pane fills in live without jank and
 * never decrypts (raw encrypted size == real disk usage). The last completed
 * snapshot is cached in localStorage so reopening the pane is instant while a fresh
 * scan runs in the background. When Workers/IndexedDB are unavailable we fall back
 * to total-only from StorageQuota.
 */
const Storage: FunctionComponent<Props> = ({ application }: Props) => {
  const databaseName = application.identifier

  const [estimate, setEstimate] = useState<StorageEstimateResult | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | undefined>(() =>
    loadCachedSnapshot(databaseName),
  )
  const [scanning, setScanning] = useState(false)
  const [scanUnavailable, setScanUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    estimateStorage()
      .then((result) => {
        if (!cancelled) {
          setEstimate(result)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isStorageUsageScanAvailable()) {
      setScanUnavailable(true)
      return
    }

    setScanning(true)
    const handle = scanStorageUsage(databaseName, {
      onSnapshot: (next) => {
        setSnapshot(next)
        if (next.done) {
          setScanning(false)
          saveCachedSnapshot(databaseName, next)
        }
      },
      onError: () => {
        setScanning(false)
        setScanUnavailable(true)
      },
    })

    if (!handle) {
      setScanning(false)
      setScanUnavailable(true)
      return
    }

    return () => {
      handle.cancel()
    }
  }, [databaseName])

  const buckets = useMemo(() => (snapshot ? sortBucketsBySize(snapshot) : []), [snapshot])

  const usage = estimate?.usage ?? snapshot?.totalBytes ?? 0
  const quota = estimate?.quota ?? 0
  const usedPercent = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0
  const measuredTotal = snapshot?.totalBytes ?? 0

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Storage</Title>
          <Text>
            See where your local disk space is going. All sizing is computed in a background worker thread that scans
            your encrypted local database progressively, so this stays up to date without slowing the app. Items are
            never decrypted — the raw on-disk (encrypted) size is what counts toward usage.
          </Text>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Total usage</Subtitle>
          {estimate ? (
            <>
              <Text className="mt-1">
                <span className="font-bold">{formatBytes(usage)}</span> used
                {quota > 0 ? (
                  <>
                    {' '}
                    of <span className="font-bold">{formatBytes(quota)}</span> ({usedPercent.toFixed(1)}%)
                  </>
                ) : null}
              </Text>
              {quota > 0 && (
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-passive-3">
                  <div
                    className={usedPercent >= 80 ? 'h-full bg-danger' : 'h-full bg-info'}
                    style={{ width: `${usedPercent}%` }}
                  />
                </div>
              )}
            </>
          ) : (
            <Text className="mt-1">Storage estimate is unavailable in this browser.</Text>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <Subtitle>Breakdown by type</Subtitle>
            {scanning && <Text className="text-passive-1">Calculating…</Text>}
          </div>

          {scanUnavailable && !snapshot ? (
            <Text className="mt-1">
              Detailed breakdown is unavailable here (background workers or local database not accessible). Total usage
              above is still reported.
            </Text>
          ) : buckets.length === 0 ? (
            <Text className="mt-1">{scanning ? 'Scanning your local database…' : 'No local items found.'}</Text>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {buckets.map((bucket) => {
                const pct = percentOf(bucket.bytes, measuredTotal)
                return (
                  <div key={bucket.contentType}>
                    <div className="flex items-baseline justify-between text-sm lg:text-xs">
                      <span className="font-medium">{contentTypeLabel(bucket.contentType)}</span>
                      <span className="text-passive-1">
                        {formatBytes(bucket.bytes)} · {bucket.count} item{bucket.count === 1 ? '' : 's'} ·{' '}
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-passive-3">
                      <div className="h-full bg-info" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
              <Text className="mt-1 text-passive-1">
                Measured {formatBytes(measuredTotal)} across {snapshot?.itemCount ?? 0} local items.
              </Text>
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      {snapshot && snapshot.largest.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <div className="flex items-center justify-between">
              <Subtitle>Largest items</Subtitle>
              {scanning && <Text className="text-passive-1">Calculating…</Text>}
            </div>
            <Text className="mt-1">The biggest stored entries on this device.</Text>

            <div className="mt-2 flex flex-col divide-y divide-border">
              {snapshot.largest.map((item) => (
                <div key={item.uuid} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium lg:text-xs" title={item.title}>
                      {item.title}
                    </span>
                    <span className="truncate text-xs text-passive-1" title={item.uuid}>
                      {contentTypeLabel(item.contentType)} · {item.uuid}
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-medium lg:text-xs">{formatBytes(item.bytes)}</span>
                </div>
              ))}
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
    </PreferencesPane>
  )
}

export default observer(Storage)
