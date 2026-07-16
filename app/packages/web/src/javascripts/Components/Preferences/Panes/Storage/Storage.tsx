import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import usePreference from '@/Hooks/usePreference'
import { getIconForItem } from '@/Utils/Items/Icons/getIconForItem'
import { estimateStorage, formatBytes, StorageEstimateResult } from '@/Utils/StorageQuota'
import { isStorageUsageScanAvailable, scanStorageUsage } from '@/Utils/Storage/StorageUsageManager'
import { StorageLargestItem, StorageUsageSnapshot } from '@/Utils/Storage/storageUsageWorkerProtocol'
import { PrefKey } from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'
import { BYTES_PER_GB, BYTES_PER_MB, resolveStorageCapState, STORAGE_CAP_UNLIMITED } from './storageCap'
import { contentTypeLabel, loadCachedSnapshot, percentOf, saveCachedSnapshot } from './storageDisplay'
import { deleteLargestItem, exportLargestItems, openLargestItem } from './storageItemActions'
import {
  isExportableStorageItem,
  isOpenableStorageItem,
  isRiskySystemStorageItem,
  resolveStorageItemLabel,
  storageItemIconType,
} from './storageItemLabel'

type Props = {
  application: WebApplication
}

const sortBucketsBySize = (snapshot: StorageUsageSnapshot) => [...snapshot.buckets].sort((a, b) => b.bytes - a.bytes)

const sortSourcesBySize = (snapshot: StorageUsageSnapshot) => [...snapshot.sources].sort((a, b) => b.bytes - a.bytes)

// --- "Maximum usage" (soft cap) select options. The value is the cap in bytes
// (stringified), plus the 'unlimited' and 'custom' sentinels. ---
const CAP_PRESET_GB = [1, 5, 10, 25, 50]
const CAP_PRESET_BYTES = CAP_PRESET_GB.map((gb) => gb * BYTES_PER_GB)
const CAP_DROPDOWN_ITEMS: DropdownItem[] = [
  { label: 'Unlimited', value: 'unlimited' },
  ...CAP_PRESET_GB.map((gb) => ({ label: `${gb} GB`, value: String(gb * BYTES_PER_GB) })),
  { label: 'Custom…', value: 'custom' },
]

type CapUnit = 'MB' | 'GB'

/** Split a byte cap into the friendliest number + MB/GB unit for the custom inputs. */
const capBytesToCustomParts = (bytes: number): { amount: string; unit: CapUnit } => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { amount: '1', unit: 'GB' }
  }
  if (bytes >= BYTES_PER_GB) {
    return { amount: String(Math.round((bytes / BYTES_PER_GB) * 100) / 100), unit: 'GB' }
  }
  return { amount: String(Math.max(1, Math.round(bytes / BYTES_PER_MB))), unit: 'MB' }
}

/** Custom inputs → byte cap; undefined when the amount isn't a usable positive number. */
const encodeCustomCap = (amount: string, unit: CapUnit): number | undefined => {
  const parsed = Number(amount)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  const bytes = Math.round(parsed * (unit === 'GB' ? BYTES_PER_GB : BYTES_PER_MB))
  return Math.max(BYTES_PER_MB, bytes)
}

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
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | undefined>(() => loadCachedSnapshot(databaseName))
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

  // --- Maximum usage: the user's SOFT cap (0 == Unlimited). Advisory only — it
  // recolors the usage bar and warns, but never blocks saving or syncing. When a
  // cap is set the bar/percentage are driven against it instead of the quota. ---
  const capBytes = usePreference(PrefKey.StorageMaxUsageBytes)
  const hasCap = Number.isFinite(capBytes) && capBytes > STORAGE_CAP_UNLIMITED
  const capState = useMemo(() => resolveStorageCapState(usage, capBytes), [usage, capBytes])
  const isPresetCap = CAP_PRESET_BYTES.includes(capBytes)
  // 'Custom…' stays selected while the user is choosing a value, even when the
  // stored cap still equals a preset (or Unlimited).
  const [customCapSelected, setCustomCapSelected] = useState(() => hasCap && !isPresetCap)
  const showCustomCapInputs = customCapSelected || (hasCap && !isPresetCap)
  const capDropdownValue = showCustomCapInputs ? 'custom' : hasCap ? String(capBytes) : 'unlimited'

  const [customCapAmount, setCustomCapAmount] = useState(() => capBytesToCustomParts(capBytes).amount)
  const [customCapUnit, setCustomCapUnit] = useState<CapUnit>(() => capBytesToCustomParts(capBytes).unit)

  // Re-sync the custom inputs when the cap changes UNDERNEATH us (another device /
  // preset picked elsewhere) — but never clobber what the user is typing: skip when
  // the local inputs already encode the stored cap.
  useEffect(() => {
    if (!hasCap || isPresetCap) {
      return
    }
    if (encodeCustomCap(customCapAmount, customCapUnit) === capBytes) {
      return
    }
    const parts = capBytesToCustomParts(capBytes)
    setCustomCapAmount(parts.amount)
    setCustomCapUnit(parts.unit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capBytes])

  const setCapPreference = useCallback(
    (bytes: number) => {
      void application.setPreference(PrefKey.StorageMaxUsageBytes, bytes)
    },
    [application],
  )

  const applyCustomCap = useCallback(
    (amount: string, unit: CapUnit) => {
      const bytes = encodeCustomCap(amount, unit)
      if (bytes !== undefined && bytes !== capBytes) {
        setCapPreference(bytes)
      }
    },
    [capBytes, setCapPreference],
  )

  const handleCapPresetChange = useCallback(
    (value: string) => {
      if (value === 'custom') {
        setCustomCapSelected(true)
        // Seed the custom fields from the current cap (default 1 GB when Unlimited)
        // and persist immediately so the displayed value always matches the pref.
        const parts = capBytesToCustomParts(capBytes)
        setCustomCapAmount(parts.amount)
        setCustomCapUnit(parts.unit)
        applyCustomCap(parts.amount, parts.unit)
        return
      }
      setCustomCapSelected(false)
      const bytes = value === 'unlimited' ? STORAGE_CAP_UNLIMITED : Number(value)
      if (Number.isFinite(bytes) && bytes !== capBytes) {
        setCapPreference(bytes)
      }
    },
    [applyCustomCap, capBytes, setCapPreference],
  )

  // Bar geometry/color: against the cap when set (warning tint at 80%, danger when
  // over), against the browser quota when Unlimited (existing behavior).
  const barPercent = hasCap ? capState.percent : usedPercent
  const barColorClass = hasCap
    ? capState.status === 'over'
      ? 'h-full bg-danger'
      : capState.status === 'warning'
        ? 'h-full bg-warning'
        : 'h-full bg-info'
    : usedPercent >= 80
      ? 'h-full bg-danger'
      : 'h-full bg-info'

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
      // Confirm HERE (naming the item + warning for system items) before deleting.
      // Resolve the same label the row shows; fall back to the content type + uuid.
      const found = application.items.findItem(row.uuid)
      const label = resolveStorageItemLabel(found, row.uuid, row.contentType)
      const risky = isRiskySystemStorageItem(row.contentType)
      const confirmed = await confirmDialog({
        title: 'Delete item',
        text:
          `Permanently delete “${label.primary}” from this device? This is a local deletion that can’t be undone.` +
          (risky
            ? ' This is a system item the app relies on — deleting it may affect app state (broken decryption or reset settings) until the next sync.'
            : ''),
        confirmButtonText: 'Delete',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }

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
          {capState.status === 'over' && (
            <div className="border-danger bg-danger-faded text-danger mt-2 rounded border border-solid p-3 text-sm">
              <span className="font-semibold">You’ve exceeded your configured storage limit</span> — free up space or
              raise the limit below. The limit is advisory: syncing and saving are never blocked.
            </div>
          )}
          {estimate ? (
            <>
              <Text className="mt-1">
                <span className="font-bold">{formatBytes(usage)}</span> used
                {hasCap ? (
                  <>
                    {' '}
                    of <span className="font-bold">{formatBytes(capBytes)}</span> limit (
                    {(capState.ratio * 100).toFixed(1)}%)
                  </>
                ) : quota > 0 ? (
                  <>
                    {' '}
                    of <span className="font-bold">{formatBytes(quota)}</span> ({usedPercent.toFixed(1)}%)
                  </>
                ) : null}
              </Text>
              {(hasCap || quota > 0) && (
                <div className="bg-passive-3 mt-2 h-2 w-full overflow-hidden rounded-full">
                  <div className={barColorClass} style={{ width: `${barPercent}%` }} />
                </div>
              )}
              {capState.status === 'warning' && (
                <Text className="text-warning mt-1">
                  Approaching your configured storage limit — {(capState.ratio * 100).toFixed(1)}% used. Free up space
                  or raise the limit below.
                </Text>
              )}
            </>
          ) : (
            <Text className="mt-1">Storage estimate is unavailable in this browser.</Text>
          )}
        </PreferencesSegment>

        <PreferencesSegment>
          <Subtitle>Maximum usage</Subtitle>
          <Text className="mt-1">
            Set a storage budget for this device. Advisory limit for this device; syncing and saving are never blocked —
            you’ll simply be warned when usage approaches or exceeds it. With Unlimited, usage is measured against the
            browser’s quota instead.
          </Text>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Dropdown
              label="Maximum storage usage"
              items={CAP_DROPDOWN_ITEMS}
              value={capDropdownValue}
              onChange={handleCapPresetChange}
            />
            {showCustomCapInputs && (
              <>
                <input
                  type="number"
                  className="border-border bg-default w-24 rounded border px-2 py-1.5 text-sm"
                  min={1}
                  step="any"
                  value={customCapAmount}
                  aria-label="Custom maximum storage amount"
                  onChange={(event) => {
                    setCustomCapAmount(event.target.value)
                    applyCustomCap(event.target.value, customCapUnit)
                  }}
                />
                <select
                  className="border-border bg-default rounded border px-2 py-1.5 text-sm"
                  value={customCapUnit}
                  aria-label="Custom maximum storage unit"
                  onChange={(event) => {
                    const unit = event.target.value as CapUnit
                    setCustomCapUnit(unit)
                    applyCustomCap(customCapAmount, unit)
                  }}
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </>
            )}
          </div>
          {hasCap && <Text className="text-passive-1 mt-2">Current limit: {formatBytes(capBytes)}.</Text>}
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
                      <span className="font-medium" title={source.description}>
                        {source.label}
                      </span>
                      <span className="text-passive-1">
                        {formatBytes(source.bytes)}
                        {source.count > 0 ? ` · ${source.count} item${source.count === 1 ? '' : 's'}` : ''} ·{' '}
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="bg-passive-3 mt-1 h-1.5 w-full overflow-hidden rounded-full">
                      <div className="bg-info h-full" style={{ width: `${pct}%` }} />
                    </div>
                    {source.description ? (
                      <div className="text-passive-1 mt-1 text-xs">{source.description}</div>
                    ) : null}
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
                    <div className="bg-passive-3 mt-1 h-1.5 w-full overflow-hidden rounded-full">
                      <div className="bg-info h-full" style={{ width: `${pct}%` }} />
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
                disabledReason={
                  selectedRows.length === 0
                    ? 'Select at least one item to export.'
                    : busy
                      ? 'Export in progress…'
                      : undefined
                }
                onClick={() => handleExport(selectedRows)}
              >
                Export selected ({selectedRows.length})
              </Button>
              <Button
                small
                disabled={busy || largest.length === 0}
                disabledReason={
                  largest.length === 0
                    ? 'Nothing stored on this device to export yet.'
                    : busy
                      ? 'Export in progress…'
                      : undefined
                }
                onClick={() => handleExport(largest)}
              >
                Export all {largest.length}
              </Button>
            </div>

            <div className="divide-border mt-2 flex flex-col divide-y">
              {largest.map((item) => {
                // Name resolution happens HERE on the main thread: the worker only
                // knows the uuid/content_type (payloads are encrypted), so look up the
                // decrypted in-memory item to show a real note title / file name / tag.
                const found = application.items.findItem(item.uuid)
                const label = resolveStorageItemLabel(found, item.uuid, item.contentType)

                // Compact rows use a TYPE ICON (text label moves to its tooltip). Reuse
                // the app's getIconForItem mapping when the item is in memory (editor /
                // file-mime / custom tag icons); fall back to a content-type icon when
                // it's absent or a type that helper doesn't handle.
                const typeText = contentTypeLabel(item.contentType)
                let iconType = storageItemIconType(item.contentType)
                let iconClassName = 'text-neutral'
                if (found) {
                  try {
                    const [reusedIcon, reusedClassName] = getIconForItem(found, application)
                    iconType = reusedIcon
                    iconClassName = reusedClassName
                  } catch {
                    /* content type not handled by getIconForItem — keep the fallback icon */
                  }
                }

                return (
                  <div key={item.uuid} className="flex items-center justify-between gap-3 py-2">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0"
                        checked={selected.has(item.uuid)}
                        onChange={() => toggleSelected(item.uuid)}
                      />
                      <span className="flex shrink-0" title={typeText}>
                        <Icon type={iconType} ariaLabel={typeText} className={iconClassName} size="medium" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className="truncate text-sm font-medium lg:text-xs"
                          title={label.secondary ?? label.primary}
                        >
                          {label.primary}
                        </span>
                        <span className="text-passive-1 truncate text-xs" title={label.secondary ?? item.uuid}>
                          {formatBytes(item.bytes)}
                          {label.secondary ? (
                            <>
                              {' · '}
                              <span className="font-mono">{label.secondary}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                    </label>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* Open: only Notes and Files can be opened in a view. */}
                      {isOpenableStorageItem(item.contentType) && (
                        <StyledTooltip label="Open">
                          <Button small disabled={busy} onClick={() => handleOpen(item.uuid)} aria-label="Open">
                            <Icon type="open-in" size="small" />
                          </Button>
                        </StyledTooltip>
                      )}
                      {/* Export: offered for EVERY item except an items key / user preferences
                          (a decrypted items key is key-material leak; prefs are private noise) —
                          so non-openable items (tags, components, themes, …) are exportable too. */}
                      {isExportableStorageItem(item.contentType) && (
                        <StyledTooltip label="Export">
                          <Button small disabled={busy} onClick={() => handleExport([item])} aria-label="Export">
                            <Icon type="download" size="small" />
                          </Button>
                        </StyledTooltip>
                      )}
                      <StyledTooltip label="Delete">
                        <Button
                          small
                          colorStyle="danger"
                          disabled={busy}
                          onClick={() => handleDelete(item)}
                          aria-label="Delete"
                        >
                          <Icon type="trash" size="small" />
                        </Button>
                      </StyledTooltip>
                    </div>
                  </div>
                )
              })}
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
    </PreferencesPane>
  )
}

export default observer(Storage)
