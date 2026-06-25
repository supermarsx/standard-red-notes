import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Icon from '@/Components/Icon/Icon'
import Switch from '@/Components/Switch/Switch'

import { achievements, METRICS, useAchievements } from '@/Achievements'
import { AchievementProgressEntry } from '@/Achievements/AchievementsService'

type Props = {
  application: WebApplication
}

type FilterKey = 'all' | 'unlocked' | 'in-progress' | 'locked'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unlocked', label: 'Unlocked' },
  { key: 'in-progress', label: 'In progress' },
  { key: 'locked', label: 'Locked' },
]

const formatUnlockedAt = (iso?: string): string | null => {
  if (!iso) {
    return null
  }
  const date = new Date(iso)
  return isNaN(date.getTime()) ? null : date.toLocaleDateString()
}

const isInProgress = (entry: AchievementProgressEntry): boolean =>
  !entry.unlocked && !entry.def.hidden && entry.current > 0

const matchesFilter = (entry: AchievementProgressEntry, filter: FilterKey): boolean => {
  switch (filter) {
    case 'unlocked':
      return entry.unlocked
    case 'locked':
      return !entry.unlocked
    case 'in-progress':
      return isInProgress(entry)
    default:
      return true
  }
}

// Compact grid tile — many of these fit per row, so the whole list is scannable
// instead of one long column of full-width rows.
const AchievementTile: FunctionComponent<{
  entry: AchievementProgressEntry
  recordTimestamps: boolean
  individuallyEnabled: boolean
}> = ({ entry, recordTimestamps, individuallyEnabled }) => {
  const { def, current, unlocked, unlockedAt } = entry
  const isMystery = def.hidden && !unlocked

  const name = isMystery ? '???' : def.name
  const description = isMystery ? 'Hidden — keep using the app to discover it.' : def.description
  const clampedCurrent = Math.min(current, def.threshold)
  const percent = def.threshold > 0 ? Math.round((clampedCurrent / def.threshold) * 100) : 0
  const unlockedDate = recordTimestamps ? formatUnlockedAt(unlockedAt) : null

  return (
    <div
      // `group` + hover-raise: hovering un-truncates the name and un-clamps the
      // description (see group-hover below) so a long achievement can be read in
      // full temporarily; z-10 lifts it above neighbours while expanded.
      className={`group relative flex flex-col gap-1.5 rounded-md border border-solid p-2.5 transition-shadow hover:z-10 ${
        unlocked ? 'border-info/40 bg-default shadow-sm' : 'border-border bg-contrast'
      } ${individuallyEnabled ? '' : 'opacity-60'}`}
      title={isMystery ? 'Hidden achievement' : `${def.name} — ${def.description}`}
    >
      <div className="flex items-center gap-2">
        <Icon
          type={unlocked ? 'star-filled' : isMystery ? 'help' : 'star'}
          size="small"
          className={`flex-shrink-0 ${unlocked ? 'text-info' : 'text-passive-1'}`}
        />
        <span
          className={`min-w-0 flex-grow truncate group-hover:overflow-visible group-hover:whitespace-normal text-sm font-bold ${
            unlocked ? 'text-text' : 'text-passive-1'
          }`}
        >
          {name}
        </span>
        {unlocked && <Icon type="check-circle-filled" size="small" className="flex-shrink-0 text-success" />}
        <Switch
          className="flex-shrink-0"
          checked={individuallyEnabled}
          onChange={(checked) => achievements.setAchievementEnabled(def.id, checked)}
        />
      </div>

      <p className={`m-0 line-clamp-2 group-hover:line-clamp-none text-xs ${unlocked ? 'text-neutral' : 'text-passive-1'}`}>
        {description}
      </p>

      {unlocked
        ? unlockedDate && <div className="text-[0.625rem] font-semibold text-passive-1">Unlocked {unlockedDate}</div>
        : !isMystery && (
            <div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-passive-3">
                <div className="h-full rounded-full bg-info" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-0.5 text-[0.625rem] font-semibold text-passive-1">
                {clampedCurrent.toLocaleString()} / {def.threshold.toLocaleString()}
              </div>
            </div>
          )}
    </div>
  )
}

const Achievements: FunctionComponent<Props> = (_props: Props) => {
  const { progress, config, unlockedCount, total } = useAchievements()

  // Count each time the user opens the Achievements pane (drives the
  // "Trophy Polisher" achievement). Once per mount.
  useEffect(() => {
    achievements.increment(METRICS.achievementsViewed)
  }, [])

  const [filter, setFilter] = useState<FilterKey>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const counts = useMemo(
    () => ({
      all: progress.length,
      unlocked: progress.filter((entry) => entry.unlocked).length,
      'in-progress': progress.filter(isInProgress).length,
      locked: progress.filter((entry) => !entry.unlocked).length,
    }),
    [progress],
  )

  // Group the (filtered) achievements by category, preserving definition order.
  const byCategory = useMemo(() => {
    const groups = new Map<string, AchievementProgressEntry[]>()
    for (const entry of progress) {
      if (!matchesFilter(entry, filter)) {
        continue
      }
      const list = groups.get(entry.def.category) ?? []
      list.push(entry)
      groups.set(entry.def.category, list)
    }
    return Array.from(groups.entries())
  }, [progress, filter])

  const overallPercent = total > 0 ? Math.round((unlockedCount / total) * 100) : 0

  const toggleCategory = (category: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(category) ? next.delete(category) : next.add(category)
      return next
    })

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Achievements</Title>
          <Text>
            Earn badges as you use Standard Red Notes — for writing, linking, customizing, syncing, and more. Progress is
            tracked locally on this device only; nothing is synced or sent to a server.
          </Text>

          <div className="mt-4 flex items-center gap-3 rounded-md border border-solid border-border bg-contrast p-4">
            <Icon type="star-filled" size="large" className="flex-shrink-0 text-info" />
            <div className="min-w-0 flex-grow">
              <div className="text-lg font-bold text-text">
                {unlockedCount} / {total} unlocked
              </div>
              <div className="mt-1 h-2 w-full max-w-xs overflow-hidden rounded-full bg-passive-3">
                <div className="h-full rounded-full bg-info" style={{ width: `${overallPercent}%` }} />
              </div>
            </div>
            <div className="flex-shrink-0 text-2xl font-bold text-info">{overallPercent}%</div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Track achievements</Subtitle>
              <Text className="text-passive-0">
                Turn the whole achievements system on or off. While off, no new achievements unlock.
              </Text>
            </div>
            <Switch checked={config.enabled} onChange={(checked) => achievements.setMasterEnabled(checked)} />
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Record unlock date &amp; time</Subtitle>
              <Text className="text-passive-0">When on, each achievement records when it was unlocked.</Text>
            </div>
            <Switch checked={config.recordTimestamps} onChange={(checked) => achievements.setRecordTimestamps(checked)} />
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Unlock notifications</Subtitle>
              <Text className="text-passive-0">Show a notification when you unlock an achievement.</Text>
            </div>
            <Switch checked={config.showUnlockToasts} onChange={(checked) => achievements.setShowUnlockToasts(checked)} />
          </div>

          {/* Filter — scope the (otherwise long) list to what you care about. */}
          <div className="mt-5 flex flex-wrap gap-1.5">
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-full border border-solid px-3 py-1 text-xs font-semibold ${
                  filter === key
                    ? 'border-info bg-info text-info-contrast'
                    : 'border-border bg-default text-passive-0 hover:text-text'
                }`}
              >
                {label} ({counts[key]})
              </button>
            ))}
          </div>
        </PreferencesSegment>

        {byCategory.length === 0 ? (
          <PreferencesSegment>
            <div className="py-6 text-center text-sm text-passive-1">No achievements match this filter.</div>
          </PreferencesSegment>
        ) : (
          byCategory.map(([category, entries]) => {
            const isCollapsed = collapsed.has(category)
            const unlockedInCategory = entries.filter((entry) => entry.unlocked).length
            return (
              <PreferencesSegment key={category}>
                <button
                  type="button"
                  onClick={() => toggleCategory(category)}
                  className="mt-3 flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-contrast"
                  aria-expanded={!isCollapsed}
                >
                  <Icon
                    type={isCollapsed ? 'chevron-right' : 'chevron-down'}
                    size="small"
                    className="flex-shrink-0 text-passive-1"
                  />
                  <span className="flex-grow font-semibold text-text">{category}</span>
                  <span className="flex-shrink-0 text-xs font-semibold text-passive-1">
                    {unlockedInCategory}/{entries.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {entries.map((entry) => (
                      <AchievementTile
                        key={entry.def.id}
                        entry={entry}
                        recordTimestamps={config.recordTimestamps}
                        individuallyEnabled={config.perAchievement[entry.def.id] !== false}
                      />
                    ))}
                  </div>
                )}
              </PreferencesSegment>
            )
          })
        )}
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Achievements)
