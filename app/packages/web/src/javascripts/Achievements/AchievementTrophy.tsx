/**
 * Standard Red Notes: trophy glyph for achievement-unlock toasts.
 *
 * The icons package has no trophy/award/medal asset, so this is a small inline
 * SVG (Material Symbols "emoji events" outline, 24x24 viewBox) filled with
 * `currentColor`. `achievementUnlockToastIcon` colors it by the achievement's
 * derived tier (see achievementTier.ts) and is passed to `addToast({ icon })`,
 * replacing only the icon area of the toast — layout/behavior are unchanged.
 */

import { CSSProperties, FunctionComponent, ReactNode } from 'react'

import { AchievementTierSource, tierForAchievement } from './achievementTier'

export const TrophyIcon: FunctionComponent<{
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}> = ({ className, style, 'aria-label': ariaLabel }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    role="img"
    aria-label={ariaLabel}
    aria-hidden={ariaLabel ? undefined : true}
    focusable="false"
  >
    <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z" />
  </svg>
)

/** Tier-colored trophy ReactNode for the unlock toast's icon slot. */
export function achievementUnlockToastIcon(def: AchievementTierSource): ReactNode {
  const tier = tierForAchievement(def)
  return (
    <TrophyIcon className="h-5 w-5" style={{ color: tier.color }} aria-label={`${tier.label} achievement trophy`} />
  )
}
