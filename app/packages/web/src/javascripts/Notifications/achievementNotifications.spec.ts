import {
  listAchievementNotifications,
  recordAchievementNotification,
  removeAchievementNotification,
  subscribeAchievementNotifications,
} from './achievementNotifications'

const STORAGE_KEY = 'standardnotes.notifications.achievements.v1'

describe('achievementNotifications', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('lists nothing initially', () => {
    expect(listAchievementNotifications()).toEqual([])
  })

  it('records an unlock with a timestamp', () => {
    recordAchievementNotification('first-note')
    const records = listAchievementNotifications()
    expect(records).toHaveLength(1)
    expect(records[0].achievementId).toBe('first-note')
    expect(typeof records[0].at).toBe('string')
    expect(Number.isNaN(Date.parse(records[0].at))).toBe(false)
  })

  it('dedupes by achievement id', () => {
    recordAchievementNotification('first-note')
    recordAchievementNotification('first-note')
    expect(listAchievementNotifications()).toHaveLength(1)
  })

  it('preserves append order (oldest first)', () => {
    recordAchievementNotification('a')
    recordAchievementNotification('b')
    expect(listAchievementNotifications().map((record) => record.achievementId)).toEqual(['a', 'b'])
  })

  it('removes a recorded unlock', () => {
    recordAchievementNotification('a')
    recordAchievementNotification('b')
    removeAchievementNotification('a')
    expect(listAchievementNotifications().map((record) => record.achievementId)).toEqual(['b'])
  })

  it('ignores removal of an unknown id', () => {
    recordAchievementNotification('a')
    removeAchievementNotification('missing')
    expect(listAchievementNotifications()).toHaveLength(1)
  })

  it('survives corrupt storage', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(listAchievementNotifications()).toEqual([])
    recordAchievementNotification('a')
    expect(listAchievementNotifications()).toHaveLength(1)
  })

  it('filters malformed entries out of storage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ achievementId: 'ok', at: 'now' }, { bogus: true }, 42]))
    expect(listAchievementNotifications().map((record) => record.achievementId)).toEqual(['ok'])
  })

  it('notifies same-tab subscribers on record and remove', () => {
    const callback = jest.fn()
    const unsubscribe = subscribeAchievementNotifications(callback)
    recordAchievementNotification('a')
    expect(callback).toHaveBeenCalledTimes(1)
    removeAchievementNotification('a')
    expect(callback).toHaveBeenCalledTimes(2)
    unsubscribe()
    recordAchievementNotification('b')
    expect(callback).toHaveBeenCalledTimes(2)
  })
})
