import { FunctionComponent, useCallback, useMemo } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { IconType, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'
import Switch from '@/Components/Switch/Switch'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import usePreference from '@/Hooks/usePreference'
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  SearchIndexSchedulerMode,
  SearchIndexScopeMode,
} from '@/Utils/Items/Search/searchIndexSettings'

type Props = {
  application: WebApplication
}

const SCHEDULER_ITEMS: DropdownItem[] = [
  { label: 'On change (keep live)', value: 'on-change' },
  { label: 'When idle', value: 'idle' },
  { label: 'Every N minutes', value: 'interval' },
  { label: 'Manual only', value: 'manual' },
]

const SCOPE_ITEMS: DropdownItem[] = [
  { label: 'Index all notes', value: 'all' },
  { label: 'Only notes with selected tags (whitelist)', value: 'include' },
  { label: 'Exclude notes with selected tags (blacklist)', value: 'exclude' },
]

type RunnerStatus = 'disabled' | 'idle' | 'indexing' | 'stopped'

const statusLabel = (status: RunnerStatus): string => {
  switch (status) {
    case 'disabled':
      return 'Disabled'
    case 'indexing':
      return 'Indexing…'
    case 'idle':
      return 'Idle'
    case 'stopped':
      return 'Worker stopped'
  }
}

/** Icon + tint that visually mirrors the current runner status. */
const statusIcon = (status: RunnerStatus): { type: IconType; className: string } => {
  switch (status) {
    case 'indexing':
      return { type: 'sync', className: 'animate-spin text-info' }
    case 'idle':
      return { type: 'check-circle', className: 'text-success' }
    case 'stopped':
      return { type: 'close', className: 'text-danger' }
    case 'disabled':
      return { type: 'eye-off', className: 'text-passive-1' }
  }
}

const NumberPref: FunctionComponent<{
  application: WebApplication
  prefKey:
    PrefKey.MaxIndexedBodyLength | PrefKey.MaxIndexedNotes | PrefKey.SearchMinQueryLength | PrefKey.SearchQueryCacheSize
  label: string
  description: string
  min: number
  max: number
}> = observer(({ application, prefKey, label, description, min, max }) => {
  const value = usePreference(prefKey) as number
  const onChange = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) {
        return
      }
      const clamped = Math.min(max, Math.max(min, Math.round(next)))
      void application.setPreference(prefKey, clamped as never)
    },
    [application, prefKey, min, max],
  )
  return (
    <div className="mt-3">
      <Subtitle>{label}</Subtitle>
      <Text>{description}</Text>
      <input
        className="border-border bg-default mt-2 w-32 rounded border px-2 py-1.5 text-sm"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
})

/**
 * Standard Red Notes: Search & Indexing pane. The dedicated home for everything
 * about the client-side full-text index of decrypted notes:
 *  - live STATUS (built? entries indexed, indexing in progress, worker vs. main);
 *  - master enable + Start/Stop/Rebuild-now/Purge controls;
 *  - scheduler MODE (on-change / idle / interval / manual) with the interval input;
 *  - inclusion/exclusion SCOPE (whitelist/blacklist by tag);
 *  - the indexing LIMITS (max notes, per-note body cap) and the search prefs that
 *    were already wired (min query length, query cache size).
 *
 * All runtime wiring lives in SearchIndexRunner / ItemListController; this pane is
 * a thin observer + controller of them.
 */
const SearchIndexing: FunctionComponent<Props> = ({ application }: Props) => {
  const runner = application.searchIndexRunner
  const { settings, status, isRunning, isIndexing, isWorkerKilled, currentJob } = runner
  const indexState = application.itemListController.searchIndexState

  const tags = application.items.getDisplayableTags()
  const tagOptions = useMemo(
    () => tags.map((tag) => ({ uuid: tag.uuid, title: tag.title })).sort((a, b) => a.title.localeCompare(b.title)),
    [tags],
  )
  const selectedTagIds = useMemo(() => new Set(settings.scope.tagIds), [settings.scope.tagIds])

  const handleEnabledToggle = useCallback((value: boolean) => runner.setEnabled(value), [runner])
  const handleStart = useCallback(() => runner.start(), [runner])
  const handleStop = useCallback(() => runner.stop(), [runner])
  const handleRebuild = useCallback(() => void runner.rebuildNow(), [runner])
  const handlePurge = useCallback(() => {
    if (window.confirm('Purge the search index? It will be cleared and rebuilt on the next search or rebuild.')) {
      runner.purgeIndex()
    }
  }, [runner])
  const handleKillWorker = useCallback(() => {
    if (
      window.confirm(
        'Stop the search indexer worker thread? Indexing halts and search falls back to what is already indexed (and substring search). You can restart the worker at any time.',
      )
    ) {
      runner.killWorker()
    }
  }, [runner])
  const handleRestartWorker = useCallback(() => runner.restartWorker(), [runner])

  const handleSchedulerModeChange = useCallback(
    (value: string) => runner.setSchedulerMode(value as SearchIndexSchedulerMode),
    [runner],
  )

  const handleIntervalChange = useCallback(
    (value: number) => {
      if (Number.isFinite(value)) {
        runner.setIntervalMinutes(value)
      }
    },
    [runner],
  )

  const handleScopeModeChange = useCallback(
    (value: string) => runner.setScopeMode(value as SearchIndexScopeMode),
    [runner],
  )

  const toggleScopeTag = useCallback(
    (uuid: string) => {
      const next = new Set(settings.scope.tagIds)
      if (next.has(uuid)) {
        next.delete(uuid)
      } else {
        next.add(uuid)
      }
      runner.setScopeTagIds([...next])
    },
    [runner, settings.scope.tagIds],
  )

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Search &amp; Indexing</Title>
          <Text>
            The background indexer keeps a client-side full-text index of your decrypted notes warm so note-list search
            stays fast on large accounts. Building runs in a background worker thread, off the UI thread, so it never
            freezes the app. When disabled, search falls back to the on-demand index/substring path.
          </Text>

          <HorizontalSeparator classes="my-4" />

          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Background indexer</Subtitle>
              <Text>Master on/off for the background indexer and its scheduler. On by default.</Text>
            </div>
            <Switch checked={settings.enabled} onChange={handleEnabledToggle} />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center gap-2">
            <Icon type="search" className="text-info" />
            <Subtitle>Status</Subtitle>
          </div>

          <Text className="mt-1 flex items-center gap-1.5">
            <Icon type={statusIcon(status).type} size="small" className={statusIcon(status).className} />
            State: <span className="font-bold">{statusLabel(status)}</span>
            {isRunning ? ' · running' : ' · stopped'}
            {isWorkerKilled
              ? ' · worker killed'
              : indexState.isThreaded
                ? ' · worker thread'
                : ' · main thread (fallback)'}
          </Text>

          <Text className="mt-1 flex items-center gap-1.5">
            <Icon type="notes" size="small" className="text-passive-1" />
            Index:{' '}
            {indexState.isBuilt ? (
              <span className="font-bold">{indexState.size} notes indexed</span>
            ) : (
              <span>not built yet</span>
            )}
            {isIndexing ? ' · rebuilding…' : ''}
          </Text>

          {/* Live "current job": what the indexer is chewing through right now. */}
          {isIndexing && currentJob && (
            <Text className="mt-1 flex items-center gap-1.5">
              <Icon type="sync" size="small" className="text-info animate-spin" />
              Current job:{' '}
              <span className="font-bold">
                indexing {currentJob.processed.toLocaleString()} / {currentJob.total.toLocaleString()} notes
              </span>
              {currentJob.total > 0 ? ` · ${Math.round((currentJob.processed / currentJob.total) * 100)}%` : ''}
            </Text>
          )}

          {isWorkerKilled && (
            <Text className="text-danger mt-1 flex items-center gap-1.5">
              <Icon type="warning" size="small" className="text-danger" />
              The indexer worker thread is stopped. Search uses the existing index / substring fallback until you
              restart it.
            </Text>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={handleStart} disabled={!settings.enabled || isRunning || isWorkerKilled}>
              <span className="flex items-center gap-1.5">
                <Icon type="sync" size="small" />
                Start
              </span>
            </Button>
            <Button onClick={handleStop} disabled={!isRunning}>
              <span className="flex items-center gap-1.5">
                <Icon type="close" size="small" />
                Stop
              </span>
            </Button>
            <Button primary onClick={handleRebuild} disabled={!settings.enabled || isIndexing || isWorkerKilled}>
              <span className="flex items-center gap-1.5">
                <Icon type="sync" size="small" className={isIndexing ? 'animate-spin' : ''} />
                {isIndexing ? 'Rebuilding…' : 'Rebuild now'}
              </span>
            </Button>
            <Button colorStyle="danger" onClick={handlePurge} disabled={isIndexing}>
              <span className="flex items-center gap-1.5">
                <Icon type="trash" size="small" />
                Purge index
              </span>
            </Button>
          </div>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Worker thread</Subtitle>
          <Text>
            The heavy indexing runs in a background Web Worker so it never freezes the UI. Kill it to hard-stop indexing
            (search keeps working against whatever is already indexed); restart it to resume and rebuild.
          </Text>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button colorStyle="danger" onClick={handleKillWorker} disabled={isWorkerKilled}>
              <span className="flex items-center gap-1.5">
                <Icon type="close" size="small" />
                Kill worker
              </span>
            </Button>
            <Button primary onClick={handleRestartWorker} disabled={!isWorkerKilled}>
              <span className="flex items-center gap-1.5">
                <Icon type="restore" size="small" />
                Restart worker
              </span>
            </Button>
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Scheduler</Subtitle>
          <Text>
            How the index is refreshed. <span className="font-semibold">On change</span> keeps it live as you edit notes
            (incremental). <span className="font-semibold">When idle</span> rebuilds while the app is idle.{' '}
            <span className="font-semibold">Every N minutes</span> rebuilds periodically.{' '}
            <span className="font-semibold">Manual only</span> rebuilds solely when you click Rebuild now.
          </Text>

          <div className="mt-2 max-w-xs">
            <Dropdown
              label="Scheduler mode"
              items={SCHEDULER_ITEMS}
              value={settings.schedulerMode === 'off' ? 'manual' : settings.schedulerMode}
              onChange={handleSchedulerModeChange}
              disabled={!settings.enabled}
              fullWidth
            />
          </div>

          {settings.schedulerMode === 'interval' && (
            <div className="mt-3">
              <Subtitle>Interval (minutes)</Subtitle>
              <Text>
                Re-index every N minutes ({MIN_INTERVAL_MINUTES}–{MAX_INTERVAL_MINUTES}). Default 15.
              </Text>
              <input
                className="border-border bg-default mt-2 w-24 rounded border px-2 py-1.5 text-sm"
                type="number"
                min={MIN_INTERVAL_MINUTES}
                max={MAX_INTERVAL_MINUTES}
                value={settings.intervalMinutes}
                disabled={!settings.enabled}
                onChange={(event) => handleIntervalChange(Number(event.target.value))}
              />
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Inclusions &amp; exclusions</Subtitle>
          <Text>
            Control which notes are indexed by tag. A whitelist indexes only notes carrying a selected tag; a blacklist
            drops notes carrying a selected tag. Default indexes everything.
          </Text>

          <div className="mt-2 max-w-md">
            <Dropdown
              label="Scope"
              items={SCOPE_ITEMS}
              value={settings.scope.mode}
              onChange={handleScopeModeChange}
              fullWidth
            />
          </div>

          {settings.scope.mode !== 'all' && (
            <div className="mt-3">
              <Subtitle>Tags</Subtitle>
              {tagOptions.length === 0 ? (
                <Text className="mt-1">You have no tags yet.</Text>
              ) : (
                <div className="border-border mt-1 flex max-h-56 flex-col gap-1 overflow-auto rounded border p-2">
                  {tagOptions.map((tag) => (
                    <label key={tag.uuid} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedTagIds.has(tag.uuid)}
                        onChange={() => toggleScopeTag(tag.uuid)}
                      />
                      <span className="truncate">{tag.title}</span>
                    </label>
                  ))}
                </div>
              )}
              <Text className="text-passive-1 mt-1">
                {settings.scope.tagIds.length} tag{settings.scope.tagIds.length === 1 ? '' : 's'} selected
                {settings.scope.tagIds.length === 0 ? ' — indexing all notes until at least one tag is selected.' : ''}
              </Text>
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Limits</Subtitle>
          <Text>Caps that protect memory and keep indexing fast on large accounts.</Text>

          <NumberPref
            application={application}
            prefKey={PrefKey.MaxIndexedNotes}
            label="Max indexed notes"
            description={`Skip building the full index when more than this many notes are displayable (substring search still works). Default ${PrefDefaults[PrefKey.MaxIndexedNotes]}.`}
            min={100}
            max={1000000}
          />
          <NumberPref
            application={application}
            prefKey={PrefKey.MaxIndexedBodyLength}
            label="Max indexed body length (characters)"
            description={`How many characters of each note's body are fed into the index. Default ${PrefDefaults[PrefKey.MaxIndexedBodyLength]}.`}
            min={1000}
            max={1000000}
          />
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Search behavior</Subtitle>
          <Text>Tuning for how the index serves queries.</Text>

          <NumberPref
            application={application}
            prefKey={PrefKey.SearchMinQueryLength}
            label="Minimum query length"
            description={`Queries shorter than this fall back to substring search. Default ${PrefDefaults[PrefKey.SearchMinQueryLength]}.`}
            min={1}
            max={20}
          />
          <NumberPref
            application={application}
            prefKey={PrefKey.SearchQueryCacheSize}
            label="Query cache size"
            description={`How many recent query results the index caches. Default ${PrefDefaults[PrefKey.SearchQueryCacheSize]}.`}
            min={0}
            max={1000}
          />
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(SearchIndexing)
