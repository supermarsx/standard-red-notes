import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import { estimateStorage, formatBytes, StorageEstimateResult } from '@/Utils/StorageQuota'
import { isStorageUsageScanAvailable, scanStorageUsage } from '@/Utils/Storage/StorageUsageManager'
import { StorageLargestItem, StorageUsageSnapshot } from '@/Utils/Storage/storageUsageWorkerProtocol'
import { contentTypeLabel, loadCachedSnapshot, percentOf, saveCachedSnapshot } from './storageDisplay'
import { deleteLargestItem, exportLargestItems, openLargestItem } from './storageItemActions'

type Props = {
  application: WebApplication
}

const sortBucketsBySize = (snapshot: StorageUsageSnapshot) =>
  [...snapshot.buckets].sort((a, b) => b.bytes - a.bytes)

const sortSourcesBySize = (snapshot: StorageUsageSnapshot) =>
  [...snapshot.sources].sort((a, b) => b.bytes - a.bytes)

/**
 * Standard Red Notes: Storage pane. Shows where local disk space goes and lets the
 * user act on the biggest items.
 *
 *  - Total used + quota (StorageQuota.estimateStorage) with a usage bar.
 *  - A COMPLETE breakdown by SOURCE that reconciles to the reported total: the items
 *    database (further broken down per content_type), the service-worker App cache
 *    (offline assets — usually the biggest chunk), localStorage (Local settings),
 *    any other IndexedDB databases, and an "Unaccounted" remainder so the rows
 *    always sum to the total (never "100MB but nothing shown").
 *  - The top-20 largest stored entries, each with Open / Delete / Export actions and
 *    a multi-select for exporting a chosen subset (or all) as native-format zip.
 *
 * Sizing is computed OFF the main thread by storageUsage.worker.ts via
 * StorageUsageManager: the worker cursors the encrypted IndexedDB entries read-only,
 * sums Cache Storage and any auxiliary databases, and streams progressive snapshots;
 * the manager merges in main-thread-only localStorage + the Unaccounted remainder.
 * Items are never decrypted (raw encrypted size == real disk usage). The last
 * completed snapshot is cached in localStorage so reopening the pane is instant while
 * a fresh scan runs in the background.
 */
const Storage: FunctionComponent<Props> = ({ application }: Props) => {
  const databaseName = application.identifier

  const [estimate, setEstimate] = useState<StorageEstimateResult | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | undefined>(() =>
    loadCachedSnapshot(databaseName),
  )
  const [scanning, setScanning] = useState(false)
  const [scanUnavailable, setScanUnavailable] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let handle: ReturnType<typeof scanStorageUsage> | undefined

    if (!isStorageUsageScanAvailable()) {
      setScanUnavailable(true)
    } else {
      setScanning(true)
    }

    // Get the origin total first so the worker scan can synthesize an accurate
    // "Unaccounted" remainder that makes the breakdown reconcile to it.
    estimateStorage()
      .then((result) => {
        if (cancelled) {
          return
        }
        setEstimate(result)

        if (!isStorageUsageScanAvailable()) {
          return
        }

        handle = scanStorageUsage(
          databaseName,
          {
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
          },
          { estimatedUsage: result?.usage },
        )

        if (!handle) {
          setScanning(false)
          setScanUnavailable(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScanning(false)
        }
      })

    return () => {
      cancelled = true
      handle?.cancel()
    }
  }, [databaseName])

  const buckets = useMemo(() => (snapshot ? sortBucketsBySize(snapshot) : []), [snapshot])
  const sources = useMemo(() => (snapshot ? sortSourcesBySize(snapshot) : []), [snapshot])

  const usage = estimate?.usage ?? snapshot?.totalBytes ?? 0
  const quota = estimate?.quota ?? 0
  const usedPercent = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0
  // The breakdown reconciles to the origin total when we have one (so the rows sum
  // to "used"); otherwise it reconciles to what we measured.
  const breakdownTotal = sources.reduce((sum, source) => sum + source.bytes, 0)

  const largest = snapshot?.largest ?? []

  const toggleSelected = useCallback((uuid: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(uuid)) {
        next.delete(uuid)
      } else {
        next.add(uuid)
      }
      return next
    })
  }, [])

  const handleOpen = useCallback(
    async (uuid: string) => {
      await openLargestItem(application, uuid)
    },
    [application],
  )

  const handleDelete = useCallback(
    async (row: StorageLargestItem) => {
      setBusy(true)
      try {
        const deleted = await deleteLargestItem(application, row)
        if (deleted) {
          setSelected((prev) => {
            const next = new Set(prev)
            next.delete(row.uuid)
            return next
          })
        }
      } finally {
        setBusy(false)
      }
    },
    [application],
  )

  const handleExport = useCallback(
    async (rows: StorageLargestItem[]) => {
      if (rows.length === 0) {
        return
      }
      setBusy(true)
      try {
        await exportLargestItems(application, rows)
      } finally {
        setBusy(false)
      }
    },
    [application],
  )

  const selectedRows = useMemo(() => largest.filter((item) => selected.has(item.uuid)), [largest, selected])

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Storage</Title>
          <Text>
            See where your local disk space is going. Sizing is computed in a background worker thread that scans your
            encrypted local database, the app cache (offline assets) and any other local databases, so this stays up to
            date without slowing the app. Items are never decrypted — the raw on-disk (encrypted) size is what counts
            toward usage.
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
            <Subtitle>Breakdown by source</Subtitle>
            {scanning && <Text className="text-passive-1">Calculating…</Text>}
          </div>

          {scanUnavailable && !snapshot ? (
            <Text className="mt-1">
              Detailed breakdown is unavailable here (background workers or local database not accessible). Total usage
              above is still reported.
            </Text>
          ) : sources.length === 0 ? (
            <Text className="mt-1">{scanning ? 'Scanning your local storage…' : 'No local storage measured.'}</Text>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {sources.map((source) => {
                const pct = percentOf(source.bytes, breakdownTotal)
                return (
                  <div key={source.id}>
                    <div className="flex items-baseline justify-between text-sm lg:text-xs">
                      <span className="font-medium">{source.label}</span>
                      <span className="text-passive-1">
                        {formatBytes(source.bytes)}
                        {source.count > 0 ? ` · ${source.count} item${source.count === 1 ? '' : 's'}` : ''} ·{' '}
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-passive-3">
                      <div className="h-full bg-info" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      {buckets.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <div className="flex items-center justify-between">
              <Subtitle>Items by type</Subtitle>
              {scanning && <Text className="text-passive-1">Calculating…</Text>}
            </div>
            <Text className="mt-1">
              How the {formatBytes(snapshot?.totalBytes ?? 0)} in your items database breaks down across{' '}
              {snapshot?.itemCount ?? 0} item{(snapshot?.itemCount ?? 0) === 1 ? '' : 's'}.
            </Text>

            <div className="mt-2 flex flex-col gap-3">
              {buckets.map((bucket) => {
                const pct = percentOf(bucket.bytes, snapshot?.totalBytes ?? 0)
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
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}

      {largest.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <div className="flex items-center justify-between">
              <Subtitle>Largest items</Subtitle>
              {scanning && <Text className="text-passive-1">Calculating…</Text>}
            </div>
            <Text className="mt-1">
              The biggest stored entries on this device. Select items to export them as their native format in a zip, or
              act on them individually.
            </Text>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                small
                disabled={busy || selectedRows.length === 0}
                onClick={() => handleExport(selectedRows)}
              >
                Export selected ({selectedRows.length})
              </Button>
              <Button small disabled={busy || largest.length === 0} onClick={() => handleExport(largest)}>
                Export all {largest.length}
              </Button>
            </div>

            <div className="mt-2 flex flex-col divide-y divide-border">
              {largest.map((item) => (
                <div key={item.uuid} className="flex items-center justify-between gap-3 py-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0"
                      checked={selected.has(item.uuid)}
                      onChange={() => toggleSelected(item.uuid)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium lg:text-xs" title={item.title}>
                        {item.title}
                      </span>
                      <span className="truncate text-xs text-passive-1" title={item.uuid}>
                        {contentTypeLabel(item.contentType)} · {formatBytes(item.bytes)}
                      </span>
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button small disabled={busy} onClick={() => handleOpen(item.uuid)}>
                      Open
                    </Button>
                    <Button small disabled={busy} onClick={() => handleExport([item])}>
                      Export
                    </Button>
                    <Button small colorStyle="danger" disabled={busy} onClick={() => handleDelete(item)}>
                      Delete
                    </Button>
                  </div>
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
