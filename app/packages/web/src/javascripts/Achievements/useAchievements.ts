/**
 * Standard Red Notes: React hook exposing live achievement progress + config.
 *
 * Re-renders whenever the AchievementsService notifies a change (via its
 * subscribe()), mirroring the autoMoveSetting useSyncExternalStore-style pattern.
 */

import { useCallback, useSyncExternalStore } from 'react'

import { achievements, AchievementsConfig, AchievementProgressEntry } from './AchievementsService'

export type UseAchievementsResult = {
  progress: AchievementProgressEntry[]
  config: AchievementsConfig
  unlockedCount: number
  total: number
}

export function useAchievements(): UseAchievementsResult {
  const subscribe = useCallback((onChange: () => void) => achievements.subscribe(onChange), [])

  // getSnapshot must return a stable reference between renders when nothing
  // changed, so useSyncExternalStore doesn't loop. We cache the last computed
  // snapshot and only recompute it after a notification (tracked by a version
  // string derived from the underlying data).
  const getSnapshot = useCallback((): string => {
    const progress = achievements.getProgress()
    const config = achievements.getConfig()
    // A cheap, stable signature of everything the UI cares about.
    return JSON.stringify({
      u: progress.filter((p) => p.unlocked).map((p) => p.def.id),
      c: progress.map((p) => p.current),
      cfg: config,
    })
  }, [])

  const signature = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // `signature` changes identity whenever anything relevant changed; recompute
  // the rich snapshot from it. (We intentionally read fresh objects here rather
  // than memoizing on the string to keep the hook simple and correct.)
  void signature
  const progress = achievements.getProgress()
  const config = achievements.getConfig()
  const unlockedCount = progress.filter((p) => p.unlocked).length

  return { progress, config, unlockedCount, total: progress.length }
}
