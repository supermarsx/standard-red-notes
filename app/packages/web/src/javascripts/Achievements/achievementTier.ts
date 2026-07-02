/**
 * Standard Red Notes: achievement tier derivation (pure, UI-free).
 *
 * The achievement catalog has NO explicit tier/difficulty field, so the tier is
 * DERIVED from what actually exists on each definition:
 *
 *   - `hidden: true`   → "epic": mystery achievements are the catalog's rarest,
 *     most extreme milestones (e.g. 20-year accounts, 50,000-edit notes).
 *   - `threshold >= 1000` → "gold": long-grind counters (1,000+ of something).
 *   - `threshold > 1`  → "silver": multi-step progress achievements.
 *   - `threshold <= 1` → "bronze": one-off "did this once" events.
 *
 * Colors are intentionally fixed (not theme tokens): they are trophy-metal
 * colors (bronze/silver/gold, plus epic purple) chosen at mid-luminance so the
 * filled trophy glyph reads on BOTH the light and dark toast backgrounds
 * (`bg-passive-5`). The achievements pane has no established tier palette to
 * reuse (it only uses generic `text-info` stars), so these are the canonical
 * tier colors.
 */

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'epic'

export type AchievementTierInfo = {
  tier: AchievementTier
  /** Human-readable tier name (used for accessible labels). */
  label: string
  /** CSS color for the trophy glyph; mid-luminance so it reads on light AND dark. */
  color: string
}

/** The tier the given achievement belongs to (see derivation rules above). */
export type AchievementTierSource = {
  threshold: number
  hidden?: boolean
}

const TIER_INFO: Record<AchievementTier, AchievementTierInfo> = {
  bronze: { tier: 'bronze', label: 'Bronze', color: '#cd7f32' },
  silver: { tier: 'silver', label: 'Silver', color: '#8e9aab' },
  gold: { tier: 'gold', label: 'Gold', color: '#d4a012' },
  epic: { tier: 'epic', label: 'Epic', color: '#a855f7' },
}

export function tierForAchievement(def: AchievementTierSource): AchievementTierInfo {
  if (def.hidden) {
    return TIER_INFO.epic
  }
  if (def.threshold >= 1000) {
    return TIER_INFO.gold
  }
  if (def.threshold > 1) {
    return TIER_INFO.silver
  }
  return TIER_INFO.bronze
}
