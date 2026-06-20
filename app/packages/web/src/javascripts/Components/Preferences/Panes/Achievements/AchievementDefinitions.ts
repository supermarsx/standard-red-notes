import { IconType } from '@standardnotes/snjs'
import { AccountStatistics } from '@/Components/Dashboard/Statistics'

/**
 * Achievement tiers, used purely for visual accenting (bronze/silver/gold/...).
 * They do not affect whether an achievement is earned.
 */
export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum'

/** Progress toward an achievement: `current` of `target` (same unit). */
export type AchievementProgress = {
  current: number
  target: number
}

export type Achievement = {
  /** Stable id (used as React key and for any future persistence). */
  id: string
  title: string
  description: string
  icon: IconType
  tier: AchievementTier
  /**
   * True when the achievement is earned. Derived PURELY from real, already-synced
   * account statistics — never from fabricated or server-polled data.
   */
  isEarned: (stats: AccountStatistics) => boolean
  /**
   * Progress toward the achievement. `current` is clamped to `target` by the
   * renderer; definitions may return the raw current value.
   */
  progress: (stats: AccountStatistics) => AchievementProgress
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

/** Whole days since the oldest item was created (account age anchor), or 0. */
export function accountAgeDays(stats: AccountStatistics): number {
  if (!stats.firstItemCreated) {
    return 0
  }
  return Math.max(0, Math.floor((Date.now() - stats.firstItemCreated) / MS_PER_DAY))
}

/**
 * Builds a simple "reach N of some count" achievement whose progress is the count
 * itself. `value` extracts the relevant number from the statistics snapshot.
 */
function milestone(
  id: string,
  title: string,
  description: string,
  icon: IconType,
  tier: AchievementTier,
  target: number,
  value: (stats: AccountStatistics) => number,
): Achievement {
  return {
    id,
    title,
    description,
    icon,
    tier,
    isEarned: (stats) => value(stats) >= target,
    progress: (stats) => ({ current: value(stats), target }),
  }
}

/**
 * The full achievement catalogue. Every entry is computed honestly from
 * {@link AccountStatistics} (plus account age derived from `firstItemCreated`);
 * nothing here invents data the client does not actually have.
 */
export const ACHIEVEMENTS: Achievement[] = [
  // --- Note milestones (active, non-trashed, non-archived notes) -----------
  milestone('notes-1', 'First Note', 'Create your very first note.', 'notes', 'bronze', 1, (s) => s.noteCount),
  milestone('notes-10', 'Getting Started', 'Keep 10 notes in your library.', 'notes', 'bronze', 10, (s) => s.noteCount),
  milestone('notes-100', 'Note Taker', 'Reach 100 notes.', 'notes', 'silver', 100, (s) => s.noteCount),
  milestone('notes-1000', 'Archivist', 'Amass 1,000 notes.', 'notes', 'gold', 1000, (s) => s.noteCount),

  // --- Tags ----------------------------------------------------------------
  milestone('tags-1', 'First Tag', 'Create your first tag.', 'hashtag', 'bronze', 1, (s) => s.tagCount),
  milestone('tags-10', 'Organizer', 'Create 10 tags.', 'hashtag', 'silver', 10, (s) => s.tagCount),

  // --- Files ---------------------------------------------------------------
  milestone('files-1', 'First Attachment', 'Attach your first file.', 'file', 'bronze', 1, (s) => s.fileCount),
  milestone('files-25', 'Collector', 'Attach 25 files.', 'file', 'silver', 25, (s) => s.fileCount),

  // --- Words written (approx, across notes) --------------------------------
  milestone('words-1k', 'Wordsmith', 'Write 1,000 words.', 'text', 'bronze', 1000, (s) => s.totalWords),
  milestone('words-10k', 'Author', 'Write 10,000 words.', 'text', 'silver', 10000, (s) => s.totalWords),
  milestone('words-100k', 'Novelist', 'Write 100,000 words.', 'text', 'gold', 100000, (s) => s.totalWords),

  // --- Account age (from firstItemCreated) ---------------------------------
  milestone('age-week', 'One Week In', 'Use your account for a week.', 'clock', 'bronze', 7, accountAgeDays),
  milestone('age-month', 'One Month In', 'Use your account for a month.', 'clock', 'silver', 30, accountAgeDays),
  milestone('age-year', 'Veteran', 'Use your account for a year.', 'clock', 'gold', 365, accountAgeDays),

  // --- Organization (pinned / archived usage) ------------------------------
  milestone('pinned-1', 'Pinned It', 'Pin a note for quick access.', 'pin', 'bronze', 1, (s) => s.pinnedCount),
  milestone('archived-1', 'Tidy Up', 'Archive a note to declutter.', 'archive', 'bronze', 1, (s) => s.archivedCount),

  // --- Editing (notes changed since creation) ------------------------------
  milestone('edited-10', 'Reviser', 'Edit 10 notes after creating them.', 'pencil', 'bronze', 10, (s) => s.editedNoteCount),
  milestone(
    'edited-100',
    'Perfectionist',
    'Edit 100 notes after creating them.',
    'pencil',
    'silver',
    100,
    (s) => s.editedNoteCount,
  ),
]

/** Count of earned achievements for a given statistics snapshot. */
export function countEarned(stats: AccountStatistics, achievements: Achievement[] = ACHIEVEMENTS): number {
  return achievements.reduce((total, achievement) => total + (achievement.isEarned(stats) ? 1 : 0), 0)
}
