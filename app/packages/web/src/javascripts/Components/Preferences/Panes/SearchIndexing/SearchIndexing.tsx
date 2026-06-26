import { FunctionComponent, useCallback, useMemo } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
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

const statusLabel = (status: 'disabled' | 'idle' | 'indexing'): string => {
  switch (status) {
    case 'disabled':
      return 'Disabled'
    case 'indexing':
      return 'Indexing…'
    case 'idle':
      return 'Idle'
  }
}

const NumberPref: FunctionComponent<{
  application: WebApplication
  prefKey: PrefKey.MaxIndexedBodyLength | PrefKey.MaxIndexedNotes | PrefKey.SearchMinQueryLength | PrefKey.SearchQueryCacheSize
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
        className="mt-2 w-32 rounded border border-border bg-default px-2 py-1.5 text-sm"
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
  const { settings, status, isRunning, isIndexing } = runner
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
          <Subtitle>Status</Subtitle>
          <Text className="mt-1">
            State: <span className="font-bold">{statusLabel(status)}</span>
            {isRunning ? ' · running' : ' · stopped'}
            {indexState.isThreaded ? ' · worker thread' : ' · main thread (fallback)'}
          </Text>
          <Text className="mt-1">
            Index:{' '}
            {indexState.isBuilt ? (
              <span className="font-bold">{indexState.size} notes indexed</span>
            ) : (
              <span>not built yet</span>
            )}
            {isIndexing ? ' · rebuilding…' : ''}
          </Text>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button label="Start" onClick={handleStart} disabled={!settings.enabled || isRunning} />
            <Button label="Stop" onClick={handleStop} disabled={!isRunning} />
            <Button
              label={isIndexing ? 'Rebuilding…' : 'Rebuild now'}
              primary
              onClick={handleRebuild}
              disabled={!settings.enabled || isIndexing}
            />
            <Button label="Purge index" colorStyle="danger" onClick={handlePurge} disabled={isIndexing} />
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
                className="mt-2 w-24 rounded border border-border bg-default px-2 py-1.5 text-sm"
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
                <div className="mt-1 flex max-h-56 flex-col gap-1 overflow-auto rounded border border-border p-2">
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
              <Text className="mt-1 text-passive-1">
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
