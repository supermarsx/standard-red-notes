import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  SearchIndexSchedulerMode,
} from '@/Utils/Items/Search/searchIndexSettings'

type Props = {
  application: WebApplication
}

const SCHEDULER_ITEMS: DropdownItem[] = [
  { label: 'Off (on demand only)', value: 'off' },
  { label: 'Every N minutes', value: 'interval' },
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

/**
 * Standard Red Notes: settings UI for the background search indexer. Surfaces the
 * runner's runtime state (idle / indexing / disabled), the master enable switch,
 * imperative Start/Stop/Rebuild-now controls, and the scheduler (Off / Every N
 * minutes) with its interval input. All wiring lives in SearchIndexRunner; this
 * pane is a thin observer of it.
 */
const SearchIndexPreferences: FunctionComponent<Props> = ({ application }: Props) => {
  const runner = application.searchIndexRunner
  const { settings, status, isRunning, isIndexing } = runner
  const indexState = application.itemListController.searchIndexState

  const handleEnabledToggle = useCallback(
    (value: boolean) => {
      runner.setEnabled(value)
    },
    [runner],
  )

  const handleStart = useCallback(() => runner.start(), [runner])
  const handleStop = useCallback(() => runner.stop(), [runner])
  const handleRebuild = useCallback(() => void runner.rebuildNow(), [runner])

  const handleSchedulerModeChange = useCallback(
    (value: string) => {
      runner.setSchedulerMode(value as SearchIndexSchedulerMode)
    },
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

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Search Index</Title>
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

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Status</Subtitle>
          <Text className="mt-1">
            State: <span className="font-bold">{statusLabel(status)}</span>
            {isRunning ? ' · running' : ' · stopped'}
            {indexState.isThreaded ? ' · worker thread' : ' · main thread (fallback)'}
            {indexState.isBuilt ? ` · ${indexState.size} notes indexed` : ' · not built yet'}
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
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Scheduler</Subtitle>
          <Text>
            Periodically re-index in the background so the index stays fresh. Off means the index is only (re)built on
            demand.
          </Text>

          <div className="mt-2 max-w-xs">
            <Dropdown
              label="Scheduler mode"
              items={SCHEDULER_ITEMS}
              value={settings.schedulerMode}
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
    </PreferencesPane>
  )
}

export default observer(SearchIndexPreferences)
