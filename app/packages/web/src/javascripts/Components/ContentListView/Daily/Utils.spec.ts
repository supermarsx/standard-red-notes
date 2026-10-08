import { ListableContentItem } from '../Types/ListableContentItem'
import { DailyItemsDay } from './DailyItemsDaySection'
import { dateToDailyDayIdentifier, getDailyWritingStreak } from './Utils'

const item = () => ({ uuid: 'x' }) as unknown as ListableContentItem

const dayAt = (date: Date): DailyItemsDay => ({
  dateKey: dateToDailyDayIdentifier(date),
  day: date.getDate(),
  weekday: 'Day',
  date,
  isToday: true,
  id: dateToDailyDayIdentifier(date),
})

const mappingFor = (today: Date, offsets: number[]): Record<string, ListableContentItem[]> => {
  const mapping: Record<string, ListableContentItem[]> = {}
  for (const offset of offsets) {
    const day = new Date(today)
    day.setDate(day.getDate() + offset)
    mapping[dateToDailyDayIdentifier(day)] = [item()]
  }
  return mapping
}

describe('getDailyWritingStreak', () => {
  const today = new Date(2026, 4, 20)

  it('returns 0 without a today entry section', () => {
    expect(getDailyWritingStreak(undefined, mappingFor(today, [0, -1, -2]))).toBe(0)
  })

  it('counts an unbroken run of previous days plus today', () => {
    expect(getDailyWritingStreak(dayAt(today), mappingFor(today, [0, -1, -2, -3]))).toBe(4)
  })

  it('counts the previous days but not today when today has no entry', () => {
    expect(getDailyWritingStreak(dayAt(today), mappingFor(today, [-1, -2]))).toBe(2)
  })

  it('stops at the first missing day and ignores anything beyond the gap', () => {
    // -1 and -2 are present, -3 is missing, -4 and -5 are present again.
    expect(getDailyWritingStreak(dayAt(today), mappingFor(today, [0, -1, -2, -4, -5]))).toBe(3)
  })

  it('returns 1 for today alone', () => {
    expect(getDailyWritingStreak(dayAt(today), mappingFor(today, [0]))).toBe(1)
  })

  it('returns 0 for an empty mapping, and terminates', () => {
    expect(getDailyWritingStreak(dayAt(today), {})).toBe(0)
  })

  it('treats a present-but-empty day list as a gap', () => {
    const mapping = mappingFor(today, [0, -1])
    const gap = new Date(today)
    gap.setDate(gap.getDate() - 2)
    mapping[dateToDailyDayIdentifier(gap)] = []

    expect(getDailyWritingStreak(dayAt(today), mapping)).toBe(2)
  })
})
