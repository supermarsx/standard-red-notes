/**
 * Standard Red Notes: Achievements subsystem public surface.
 *
 * Instrumentation sites import the `achievements` singleton and call
 * increment/setAtLeast/markEvent (all fire-and-forget). UI imports the hook and
 * the catalog. Metric keys are exported via METRICS for typo-safe emission.
 */

export {
  achievements,
  type AchievementsService,
  type AchievementsConfig,
  type AchievementsState,
  type AchievementProgressEntry,
} from './AchievementsService'

export {
  ACHIEVEMENTS,
  ACHIEVEMENT_CATEGORIES,
  METRICS,
  ALL_METRICS,
  NON_HIDDEN_ACHIEVEMENT_COUNT,
  definitionsForMetric,
  type AchievementDefinition,
} from './achievementDefinitions'

export { useAchievements, type UseAchievementsResult } from './useAchievements'
