import type { AdminUserTokenUsageWindow, AdminUserUsageResponse } from '@standardnotes/snjs'
import {
  adminTokenUsageProgress,
  describeAdminTokenRollOff,
  describeAdminTokenWindow,
  describeAdminUsageHistory,
} from './adminUserUsage'

const windowUsage = (overrides: Partial<AdminUserTokenUsageWindow> = {}): AdminUserTokenUsageWindow => ({
  usedTokens: 100,
  limitTokens: 500,
  resetsAt: '2026-08-13T16:00:00.000Z',
  ...overrides,
})

describe('adminUserUsage', () => {
  it('describes limited, unlimited, and unavailable token windows honestly', () => {
    expect(describeAdminTokenWindow(windowUsage())).toBe('100 tokens of 500 tokens')
    expect(describeAdminTokenWindow(windowUsage({ limitTokens: 0 }))).toBe('100 tokens · unlimited')
    expect(describeAdminTokenWindow(windowUsage({ usedTokens: null, unavailable: true }))).toBe(
      'Usage unavailable · 500 tokens limit',
    )
  })

  it('does not claim an empty rolling window has a future fixed reset', () => {
    expect(describeAdminTokenRollOff(windowUsage({ usedTokens: 0 }))).toBe('No retained usage is waiting to roll off.')
    expect(describeAdminTokenRollOff(windowUsage({ usedTokens: null, resetsAt: null, unavailable: true }))).toBe(
      'Next roll-off time unavailable.',
    )
  })

  it('bounds limited-window progress and omits progress for unlimited/unavailable windows', () => {
    expect(adminTokenUsageProgress(windowUsage())).toBe(20)
    expect(adminTokenUsageProgress(windowUsage({ usedTokens: 900 }))).toBe(100)
    expect(adminTokenUsageProgress(windowUsage({ limitTokens: 0 }))).toBeNull()
    expect(adminTokenUsageProgress(windowUsage({ usedTokens: null, unavailable: true }))).toBeNull()
  })

  it('labels retained history without implying lifetime durability', () => {
    const history = {
      retentionDays: 7,
      completeLifetimeHistory: false,
      totalEvents: 250,
      truncated: true,
      events: new Array(100).fill({ occurredAt: '2026-08-13T12:00:00.000Z', tokens: 1 }),
    } satisfies AdminUserUsageResponse['history']

    expect(describeAdminUsageHistory(history)).toBe('Showing the newest 100 of 250 retained events.')
    expect(describeAdminUsageHistory({ ...history, totalEvents: null, events: [], truncated: false })).toBe(
      'Retained usage history is unavailable.',
    )
  })
})
