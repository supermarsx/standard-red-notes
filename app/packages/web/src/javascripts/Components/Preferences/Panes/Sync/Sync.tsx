import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ApplicationEvent,
  ContentType,
  DecryptedItemInterface,
  FileItem,
  FolderContentType,
  SNFolder,
  SNNote,
  SNTag,
  VectorIconNameOrEmoji,
} from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { achievements, METRICS } from '@/Achievements'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import { formatDateAndTimeForNote } from '@/Utils/DateUtils'
import { useConnectionStatus } from '@/Hooks/useConnectionStatus'
import {
  getManualSyncModeEnabled,
  setManualSyncModeEnabled,
  subscribeManualSyncMode,
} from '@/Utils/ManualSyncSetting'

import { LocalOnlyItem, SyncItemLike, SyncSummary, summarizeSync } from './syncSummary'

type Props = {
  application: WebApplication
}

// Mirror the Dashboard / Achievements panes: recompute at most once per this
// interval, driven by item streams + sync completion. No server polling — purely
// derived from already-in-memory items and the existing sync state.
const RECOMPUTE_THROTTLE_MS = 1500

/** Best-effort display title for any item (note title / tag name / file name). */
function itemTitle(item: DecryptedItemInterface): string {
  return (item as unknown as { title?: string }).title || ''
}

/**
 * Snapshot the in-memory note/tag/file items into the plain shape the pure
 * `summarizeSync` helper consumes. We read the SAME `localOnly` flag the sync
 * engine uses (AppDataField.LocalOnly), so the partition mirrors exactly what
 * SyncService.excludeLocalOnlyItems does — without touching SyncService.
 */
function collectSyncItems(application: WebApplication): SyncItemLike[] {
  const notes = application.items.getItems<SNNote>(ContentType.TYPES.Note)
  const tags = application.items.getItems<SNTag>(ContentType.TYPES.Tag)
  const files = application.items.getItems<FileItem>(ContentType.TYPES.File)

  const map = (item: DecryptedItemInterface): SyncItemLike => ({
    uuid: item.uuid,
    content_type: item.content_type,
    localOnly: item.localOnly,
    title: itemTitle(item),
    trashed: (item as unknown as { trashed?: boolean }).trashed === true,
  })

  return [...notes.map(map), ...tags.map(map), ...files.map(map)]
}

const ICON_FOR_KIND: Record<LocalOnlyItem['kind'], VectorIconNameOrEmoji> = {
  note: 'notes',
  tag: 'hashtag',
  file: 'file',
  other: 'info',
}

type StatRowProps = {
  icon: VectorIconNameOrEmoji
  label: string
  synced: number
  localOnly: number
}

const StatRow: FunctionComponent<StatRowProps> = ({ icon, label, synced, localOnly }) => (
  <div className="flex items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
    <div className="flex items-center gap-2">
      <Icon type={icon} className="flex-shrink-0 text-neutral" size="small" />
      <span className="text-sm font-medium text-text">{label}</span>
    </div>
    <div className="flex items-center gap-4 text-sm">
      <span className="text-success" title="Synced to your account">
        {synced} synced
      </span>
      <span className={localOnly > 0 ? 'text-warning' : 'text-passive-1'} title="Kept on this device only">
        {localOnly} local-only
      </span>
    </div>
  </div>
)

const Sync: FunctionComponent<Props> = ({ application }: Props) => {
  const connection = useConnectionStatus(application)

  const [summary, setSummary] = useState<SyncSummary>(() => summarizeSync(collectSyncItems(application)))
  const [busyUuid, setBusyUuid] = useState<string | undefined>(undefined)

  // --- Manual sync mode (web-local toggle) -----------------------------------
  const [manualSyncMode, setManualSyncModeState] = useState<boolean>(() => getManualSyncModeEnabled())
  const [syncingNow, setSyncingNow] = useState(false)

  // Keep local UI state in sync with the web-local setting (e.g. cross-tab changes).
  useEffect(() => subscribeManualSyncMode(() => setManualSyncModeState(getManualSyncModeEnabled())), [])

  /**
   * Toggle Manual sync mode. Persists web-locally and immediately pushes the new mode into the
   * sync engine. When turning the mode OFF, we trigger one explicit sync so any changes that
   * piled up while manual was on get flushed to the server right away (resuming automatic sync).
   */
  const toggleManualSyncMode = useCallback(
    async (enabled: boolean) => {
      setManualSyncModeState(enabled)
      setManualSyncModeEnabled(enabled)
      application.sync.setManualSyncMode(enabled)
      if (!enabled) {
        // Returning to automatic: flush anything that accumulated while manual was on.
        try {
          await application.sync.sync({ isUserInitiated: true })
        } catch (error) {
          console.error('Failed to sync after disabling manual mode', error)
        }
      }
    },
    [application],
  )

  /** Explicit user-initiated sync ("Sync now"). Always runs, even in manual mode. */
  const syncNow = useCallback(async () => {
    setSyncingNow(true)
    achievements.increment(METRICS.manualSyncTotal)
    try {
      await application.sync.sync({ isUserInitiated: true })
      addToast({ type: ToastType.Success, message: 'Sync complete.' })
    } catch (error) {
      console.error('Manual sync failed', error)
      addToast({ type: ToastType.Error, message: 'Sync failed. Check your connection and try again.' })
    } finally {
      setSyncingNow(false)
    }
  }, [application])

  // --- throttled recompute from local item state (mirror Dashboard) ----------
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setSummary(summarizeSync(collectSyncItems(application)))
    }

    const scheduleRecompute = () => {
      if (throttleTimeout) {
        pending = true
        return
      }
      recompute()
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending) {
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const removeItemObserver = application.items.streamItems(
      [ContentType.TYPES.Note, ContentType.TYPES.Tag, ContentType.TYPES.File],
      () => scheduleRecompute(),
    )

    const removeSyncObserver = application.addEventObserver(async () => {
      scheduleRecompute()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      removeItemObserver()
      removeSyncObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application])

  /**
   * Toggle the local-only flag on a single item, reusing the existing mutator
   * setter (DecryptedItemMutator.localOnly). Clearing it re-dirties the item so it
   * uploads on the next sync; setting it keeps the item off the upload set. We then
   * trigger a sync so the change takes effect immediately. We do NOT touch
   * SyncService — `sync()` is the public entry point.
   */
  const setItemLocalOnly = useCallback(
    async (uuid: string, localOnly: boolean) => {
      const item = application.items.findItem<DecryptedItemInterface>(uuid)
      if (!item) {
        return
      }
      setBusyUuid(uuid)
      try {
        await application.mutator.changeItem(item, (mutator) => {
          mutator.localOnly = localOnly
        })
        await application.sync.sync()
        addToast({
          type: ToastType.Success,
          message: localOnly ? 'Item is now local-only (won’t sync).' : 'Item will now sync to your account.',
        })
      } catch (error) {
        console.error('Failed to change local-only state', error)
        addToast({ type: ToastType.Error, message: 'Could not change sync state for this item.' })
      } finally {
        setBusyUuid(undefined)
      }
    },
    [application],
  )

  /**
   * Bulk-mark every member note of a tag or folder local-only, reusing the existing
   * NavigationController method (which itself mutates + syncs). Excluding the notes
   * is what keeps their content off the server.
   */
  const setTagOrFolderLocalOnly = useCallback(
    async (tagOrFolder: SNTag | SNFolder, localOnly: boolean) => {
      setBusyUuid(tagOrFolder.uuid)
      try {
        await application.navigationController.setTagOrFolderNotesLocalOnly(tagOrFolder, localOnly)
        addToast({
          type: ToastType.Success,
          message: localOnly
            ? 'Notes in this tag/folder are now local-only.'
            : 'Notes in this tag/folder will now sync.',
        })
      } catch (error) {
        console.error('Failed to change tag/folder local-only state', error)
        addToast({ type: ToastType.Error, message: 'Could not change sync state for this tag/folder.' })
      } finally {
        setBusyUuid(undefined)
      }
    },
    [application],
  )

  const tagsAndFolders = useMemo(() => {
    const tags = application.items.getItems<SNTag>(ContentType.TYPES.Tag)
    const folders = application.items.getItems<SNFolder>(FolderContentType)
    // FolderContentType is the same ContentType as Tag in this model (folders are
    // tags with a flag); dedupe by uuid and split into folders vs plain tags.
    const byUuid = new Map<string, SNTag | SNFolder>()
    for (const tag of tags) {
      byUuid.set(tag.uuid, tag)
    }
    for (const folder of folders) {
      byUuid.set(folder.uuid, folder)
    }
    const all = [...byUuid.values()].filter((t) => (t as unknown as { isSmartView?: boolean }).isSmartView !== true)
    return all.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  }, [application, summary])

  const lastSyncLabel = connection.lastSyncDate
    ? formatDateAndTimeForNote(connection.lastSyncDate)
    : 'No sync yet this session'

  const connectionLabel =
    connection.signedOut
      ? 'Offline account (local only)'
      : connection.kind === 'online'
        ? 'Connected'
        : connection.kind === 'reconnecting'
          ? 'Reconnecting…'
          : 'Offline'

  const connectionIcon: VectorIconNameOrEmoji = connection.signedOut
    ? 'cloud-off'
    : connection.kind === 'online'
      ? 'sync'
      : 'cloud-off'

  const totalLocalOnly = summary.localOnly.total

  return (
    <PreferencesPane>
      {/* Overview */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Sync</Title>
          <Subtitle>See what’s synced to your account versus kept on this device, and choose what stays local.</Subtitle>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-3 rounded-md border border-border bg-contrast p-3">
              <Icon type={connectionIcon} size="medium" className="flex-shrink-0 text-info" />
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-passive-1">Status</div>
                <div className="text-sm font-bold text-text">{connectionLabel}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-md border border-border bg-contrast p-3">
              <Icon type="clock" size="medium" className="flex-shrink-0 text-info" />
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-passive-1">Last successful sync</div>
                <div className="truncate text-sm font-bold text-text">{lastSyncLabel}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-md border border-border bg-default p-3">
            <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-passive-1">
              <span>Type</span>
              <span>Synced · Local-only</span>
            </div>
            <StatRow icon="notes" label="Notes" synced={summary.synced.note} localOnly={summary.localOnly.note} />
            <StatRow icon="hashtag" label="Tags" synced={summary.synced.tag} localOnly={summary.localOnly.tag} />
            <StatRow icon="file" label="Files" synced={summary.synced.file} localOnly={summary.localOnly.file} />
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm font-bold">
              <span className="text-text">Total</span>
              <span>
                <span className="text-success">{summary.synced.total} synced</span>
                <span className="mx-1 text-passive-1">·</span>
                <span className={totalLocalOnly > 0 ? 'text-warning' : 'text-passive-1'}>
                  {totalLocalOnly} local-only
                </span>
              </span>
            </div>
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      {/* Manual sync mode */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Manual sync</Title>
          <div className="flex items-center justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Only sync when I press “Sync now”</Subtitle>
              <Text>
                When on, automatic syncing is turned off: edits stay on this device and are not sent to your account
                until you sync manually. Background syncing, the periodic timer, and live updates from other devices are
                paused. Turn this off to resume automatic syncing.
              </Text>
            </div>
            <Switch onChange={(checked) => void toggleManualSyncMode(checked)} checked={manualSyncMode} />
          </div>

          {manualSyncMode && (
            <div className="mt-3 rounded-md border border-warning bg-warning-faded p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 font-semibold text-warning">
                <Icon type="warning" size="small" className="flex-shrink-0" />
                Unsynced changes are at risk
              </div>
              <Text>
                While manual sync is on, your latest changes live only on this device. If this device is lost, wiped, or
                its data is cleared before you sync, those changes will be gone. Press “Sync now” regularly, and always
                before closing the app or switching devices.
              </Text>
            </div>
          )}

          <HorizontalSeparator classes="my-4" />

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <Subtitle>Sync now</Subtitle>
              <Text>
                Push local changes and pull the latest from your account.{' '}
                {connection.lastSyncDate ? `Last synced ${lastSyncLabel}.` : 'No sync yet this session.'}
              </Text>
            </div>
            <Button
              primary
              label={syncingNow ? 'Syncing…' : 'Sync now'}
              disabled={syncingNow || connection.signedOut}
              onClick={() => void syncNow()}
            />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      {/* What's local-only */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Kept on this device only</Title>
          <Subtitle>
            These items are excluded from sync and never leave this device. Switch any of them back to syncing.
          </Subtitle>
          {summary.localOnlyItems.length === 0 ? (
            <Text className="mt-2">
              Nothing is local-only right now — every note, tag and file is syncing to your account.
            </Text>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {summary.localOnlyItems.map((item) => (
                <li
                  key={item.uuid}
                  className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon type={ICON_FOR_KIND[item.kind]} size="small" className="flex-shrink-0 text-neutral" />
                    <span className="truncate text-sm text-text">{item.title}</span>
                  </div>
                  <Button
                    small
                    label="Sync this"
                    disabled={busyUuid === item.uuid}
                    onClick={() => setItemLocalOnly(item.uuid, false)}
                  />
                </li>
              ))}
            </ul>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      {/* Configure */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Configure selective sync</Title>
          <Subtitle>Mark a tag or folder local-only to keep all of its notes on this device.</Subtitle>
          <div className="mt-2.5 rounded border border-border bg-contrast p-3 text-sm">
            <div className="mb-1.5 flex items-center gap-2 font-semibold">
              <Icon type="info" size="small" />
              How this works
            </div>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Marking a tag/folder local-only sets every member note to local-only. The notes’ content stays on this
                device; only a tag’s membership reference may remain visible on the server.
              </li>
              <li>
                Individual notes and files can also be made local-only from their own options menu. Large files (over
                100&nbsp;MB) are kept local-only automatically.
              </li>
            </ul>
          </div>

          <HorizontalSeparator classes="my-4" />

          {tagsAndFolders.length === 0 ? (
            <Text>You don’t have any tags or folders yet.</Text>
          ) : (
            <ul className="space-y-1.5">
              {tagsAndFolders.map((tagOrFolder) => {
                const hasLocalOnly = application.navigationController.tagOrFolderHasAnyLocalOnlyNotes(tagOrFolder)
                const isFolder = (tagOrFolder as unknown as { isFolder?: boolean }).isFolder === true
                return (
                  <li
                    key={tagOrFolder.uuid}
                    className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon type={isFolder ? 'folder' : 'hashtag'} size="small" className="flex-shrink-0 text-neutral" />
                      <span className="truncate text-sm text-text">{tagOrFolder.title || 'Untitled'}</span>
                      {hasLocalOnly && (
                        <span className="rounded bg-warning px-1.5 py-0.5 text-xs text-warning-contrast">
                          local-only
                        </span>
                      )}
                    </div>
                    {hasLocalOnly ? (
                      <Button
                        small
                        label="Sync notes"
                        disabled={busyUuid === tagOrFolder.uuid}
                        onClick={() => setTagOrFolderLocalOnly(tagOrFolder, false)}
                      />
                    ) : (
                      <Button
                        small
                        label="Keep local-only"
                        disabled={busyUuid === tagOrFolder.uuid}
                        onClick={() => setTagOrFolderLocalOnly(tagOrFolder, true)}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Sync)
