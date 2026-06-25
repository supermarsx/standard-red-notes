import { FunctionComponent, useMemo } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Icon from '@/Components/Icon/Icon'
import Switch from '@/Components/Switch/Switch'

import { achievements, useAchievements } from '@/Achievements'
import { AchievementProgressEntry } from '@/Achievements/AchievementsService'

type Props = {
  application: WebApplication
}

const formatUnlockedAt = (iso?: string): string | null => {
  if (!iso) {
    return null
  }
  const date = new Date(iso)
  return isNaN(date.getTime()) ? null : date.toLocaleString()
}

const AchievementRow: FunctionComponent<{
  entry: AchievementProgressEntry
  recordTimestamps: boolean
  individuallyEnabled: boolean
}> = ({ entry, recordTimestamps, individuallyEnabled }) => {
  const { def, current, unlocked, unlockedAt } = entry
  // A still-locked HIDDEN achievement is a mystery: reveal nothing about it.
  const isMystery = def.hidden && !unlocked

  const name = isMystery ? '???' : def.name
  const description = isMystery ? 'Hidden achievement' : def.description
  const clampedCurrent = Math.min(current, def.threshold)
  const unlockedDate = recordTimestamps ? formatUnlockedAt(unlockedAt) : null

  return (
    <div
      className={`flex items-start gap-3 rounded-md border border-solid p-3 ${
        unlocked ? 'border-border bg-default shadow-sm' : 'border-border bg-contrast opacity-80'
      }`}
    >
      <Icon
        type={unlocked ? 'star-filled' : isMystery ? 'help' : 'star'}
        size="medium"
        className={`mt-0.5 flex-shrink-0 ${unlocked ? 'text-info' : 'text-passive-1'}`}
      />
      <div className="min-w-0 flex-grow">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${unlocked ? 'text-text' : 'text-passive-1'}`}>{name}</span>
          {unlocked && <Icon type="check-circle-filled" size="small" className="flex-shrink-0 text-success" />}
        </div>
        <p className={`m-0 mt-0.5 text-xs ${unlocked ? 'text-neutral' : 'text-passive-1'}`}>{description}</p>

        {unlocked ? (
          unlockedDate && <p className="m-0 mt-1 text-[0.625rem] font-semibold text-passive-1">Unlocked {unlockedDate}</p>
        ) : isMystery ? null : (
          <div className="mt-1.5">
            <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-passive-3">
              <div
                className="h-full rounded-full bg-info"
                style={{ width: `${def.threshold > 0 ? Math.round((clampedCurrent / def.threshold) * 100) : 0}%` }}
              />
            </div>
            <div className="mt-0.5 text-[0.625rem] font-semibold text-passive-1">
              {clampedCurrent.toLocaleString()} / {def.threshold.toLocaleString()}
            </div>
          </div>
        )}
      </div>
      <Switch
        className="mt-0.5 flex-shrink-0"
        checked={individuallyEnabled}
        onChange={(checked) => achievements.setAchievementEnabled(def.id, checked)}
      />
    </div>
  )
}

const Achievements: FunctionComponent<Props> = (_props: Props) => {
  const { progress, config, unlockedCount, total } = useAchievements()

  const byCategory = useMemo(() => {
    const groups = new Map<string, AchievementProgressEntry[]>()
    for (const entry of progress) {
      const list = groups.get(entry.def.category) ?? []
      list.push(entry)
      groups.set(entry.def.category, list)
    }
    return Array.from(groups.entries())
  }, [progress])

  const overallPercent = total > 0 ? Math.round((unlockedCount / total) * 100) : 0

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
            <div className="min-w-0">
              <div className="text-lg font-bold text-text">
                {unlockedCount} / {total} unlocked
              </div>
              <div className="mt-1 h-2 w-48 max-w-full overflow-hidden rounded-full bg-passive-3">
                <div className="h-full rounded-full bg-info" style={{ width: `${overallPercent}%` }} />
              </div>
            </div>
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
            <Switch
              checked={config.recordTimestamps}
              onChange={(checked) => achievements.setRecordTimestamps(checked)}
            />
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Unlock notifications</Subtitle>
              <Text className="text-passive-0">Show a notification when you unlock an achievement.</Text>
            </div>
            <Switch
              checked={config.showUnlockToasts}
              onChange={(checked) => achievements.setShowUnlockToasts(checked)}
            />
          </div>
        </PreferencesSegment>

        {byCategory.map(([category, entries]) => (
          <PreferencesSegment key={category}>
            <HorizontalSeparator classes="my-4" />
            <Subtitle>{category}</Subtitle>
            <div className="mt-3 flex flex-col gap-2">
              {entries.map((entry) => (
                <AchievementRow
                  key={entry.def.id}
                  entry={entry}
                  recordTimestamps={config.recordTimestamps}
                  individuallyEnabled={config.perAchievement[entry.def.id] !== false}
                />
              ))}
            </div>
          </PreferencesSegment>
        ))}
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Achievements)
