import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Icon from '@/Components/Icon/Icon'
import { AccountStatistics, computeAccountStatistics } from '@/Components/Dashboard/Statistics'

import { Achievement, AchievementTier, ACHIEVEMENTS, countEarned } from './AchievementDefinitions'

type Props = {
  application: WebApplication
}

// Match the dashboard: recompute at most once per this interval, driven by item
// streams / sync completion. No server polling — purely derived from synced state.
const RECOMPUTE_THROTTLE_MS = 1500

const TIER_ACCENT: Record<AchievementTier, string> = {
  bronze: 'text-warning',
  silver: 'text-neutral',
  gold: 'text-info',
  platinum: 'text-success',
}

const AchievementCard: FunctionComponent<{ achievement: Achievement; stats: AccountStatistics }> = ({
  achievement,
  stats,
}) => {
  const earned = achievement.isEarned(stats)
  const { current, target } = achievement.progress(stats)
  const clamped = Math.max(0, Math.min(current, target))
  const percent = target > 0 ? Math.round((clamped / target) * 100) : 0

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-solid p-4 ${
        earned ? 'border-border bg-default shadow-sm' : 'border-border bg-contrast opacity-75'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon
          type={earned ? 'star-filled' : achievement.icon}
          size="medium"
          className={`flex-shrink-0 ${earned ? TIER_ACCENT[achievement.tier] : 'text-passive-1'}`}
        />
        <span className={`text-sm font-bold ${earned ? 'text-text' : 'text-passive-1'}`}>{achievement.title}</span>
        {earned && <Icon type="check-circle-filled" size="small" className="ml-auto flex-shrink-0 text-success" />}
      </div>

      <p className={`m-0 text-xs ${earned ? 'text-neutral' : 'text-passive-1'}`}>{achievement.description}</p>

      <div className="mt-auto">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-passive-3">
          <div
            className={`h-full rounded-full ${earned ? 'bg-success' : 'bg-info'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-1 text-right text-[0.625rem] font-semibold text-passive-1">
          {earned ? 'Unlocked' : `${clamped.toLocaleString()} / ${target.toLocaleString()}`}
        </div>
      </div>
    </div>
  )
}

const Achievements: FunctionComponent<Props> = ({ application }: Props) => {
  // Compute once on mount; recompute on a throttle as items/sync change.
  const [stats, setStats] = useState<AccountStatistics>(() => computeAccountStatistics(application))

  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setStats(computeAccountStatistics(application))
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

  const earnedCount = useMemo(() => countEarned(stats), [stats])
  const total = ACHIEVEMENTS.length

  const { earned, locked } = useMemo(() => {
    const earnedList: Achievement[] = []
    const lockedList: Achievement[] = []
    for (const achievement of ACHIEVEMENTS) {
      if (achievement.isEarned(stats)) {
        earnedList.push(achievement)
      } else {
        lockedList.push(achievement)
      }
    }
    return { earned: earnedList, locked: lockedList }
  }, [stats])

  const overallPercent = total > 0 ? Math.round((earnedCount / total) * 100) : 0

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Achievements</Title>
          <Text>
            Badges you earn as you use Standard Red Notes. Every achievement is derived from your own synced library —
            note counts, tags, files, words written, account age and more. Nothing is recomputed against the server.
          </Text>

          <div className="mt-4 flex items-center gap-3 rounded-md border border-solid border-border bg-contrast p-4">
            <Icon type="star-filled" size="large" className="flex-shrink-0 text-info" />
            <div className="min-w-0">
              <div className="text-lg font-bold text-text">
                {earnedCount} / {total} unlocked
              </div>
              <div className="mt-1 h-2 w-48 max-w-full overflow-hidden rounded-full bg-passive-3">
                <div className="h-full rounded-full bg-info" style={{ width: `${overallPercent}%` }} />
              </div>
            </div>
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Earned {earned.length > 0 ? `(${earned.length})` : ''}</Subtitle>
          {earned.length === 0 ? (
            <Text className="mt-2">No achievements yet. Keep writing — your first badge is within reach.</Text>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {earned.map((achievement) => (
                <AchievementCard key={achievement.id} achievement={achievement} stats={stats} />
              ))}
            </div>
          )}
        </PreferencesSegment>

        {locked.length > 0 && (
          <>
            <HorizontalSeparator classes="my-4" />
            <PreferencesSegment>
              <Subtitle>Locked ({locked.length})</Subtitle>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {locked.map((achievement) => (
                  <AchievementCard key={achievement.id} achievement={achievement} stats={stats} />
                ))}
              </div>
            </PreferencesSegment>
          </>
        )}
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Achievements)
