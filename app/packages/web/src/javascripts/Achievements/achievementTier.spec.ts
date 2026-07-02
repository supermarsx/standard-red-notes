import { ACHIEVEMENTS } from './achievementDefinitions'
import { AchievementTier, tierForAchievement } from './achievementTier'

describe('tierForAchievement', () => {
  it('classifies one-off (threshold <= 1) achievements as bronze', () => {
    expect(tierForAchievement({ threshold: 1 }).tier).toBe('bronze')
    expect(tierForAchievement({ threshold: 1, hidden: false }).tier).toBe('bronze')
  })

  it('classifies multi-step (1 < threshold < 1000) achievements as silver', () => {
    expect(tierForAchievement({ threshold: 2 }).tier).toBe('silver')
    expect(tierForAchievement({ threshold: 50 }).tier).toBe('silver')
    expect(tierForAchievement({ threshold: 999 }).tier).toBe('silver')
  })

  it('classifies long-grind (threshold >= 1000) achievements as gold', () => {
    expect(tierForAchievement({ threshold: 1000 }).tier).toBe('gold')
    expect(tierForAchievement({ threshold: 50000 }).tier).toBe('gold')
  })

  it('classifies hidden (mystery) achievements as epic regardless of threshold', () => {
    expect(tierForAchievement({ threshold: 1, hidden: true }).tier).toBe('epic')
    expect(tierForAchievement({ threshold: 50000, hidden: true }).tier).toBe('epic')
  })

  it('returns a distinct valid CSS hex color and label per tier', () => {
    const tiers: { threshold: number; hidden?: boolean }[] = [
      { threshold: 1 },
      { threshold: 50 },
      { threshold: 1000 },
      { threshold: 1, hidden: true },
    ]
    const infos = tiers.map(tierForAchievement)
    for (const info of infos) {
      expect(info.color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(info.label.length).toBeGreaterThan(0)
    }
    expect(new Set(infos.map((i) => i.color)).size).toBe(4)
    expect(new Set(infos.map((i) => i.tier)).size).toBe(4)
  })

  it('maps every catalog achievement to a tier', () => {
    const validTiers: AchievementTier[] = ['bronze', 'silver', 'gold', 'epic']
    for (const def of ACHIEVEMENTS) {
      const info = tierForAchievement(def)
      expect(validTiers).toContain(info.tier)
    }
  })
})
