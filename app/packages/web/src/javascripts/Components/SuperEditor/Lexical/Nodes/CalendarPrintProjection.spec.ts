/** @jest-environment jsdom */

import { applyLiveCalendarEdit, CalendarData, getCalendarPrintSnapshot } from './CalendarNode'

describe('Calendar print projection', () => {
  it('includes every persisted event in chronological date order without a month or selection filter', () => {
    const data: CalendarData = {
      events: {
        '2026-09-02': ['Future launch'],
        '2026-08-11': ['Selected meeting', 'Selected follow-up'],
        '2026-07-30': ['Off-month planning'],
      },
    }

    const snapshot = getCalendarPrintSnapshot(data)

    expect(snapshot.events).toEqual([
      { date: '2026-07-30', text: 'Off-month planning' },
      { date: '2026-08-11', text: 'Selected meeting' },
      { date: '2026-08-11', text: 'Selected follow-up' },
      { date: '2026-09-02', text: 'Future launch' },
    ])
    expect(data.events['2026-08-11']).toEqual(['Selected meeting', 'Selected follow-up'])
  })

  it('adds a current unblurred event to the print model without mutating persisted events', () => {
    const data: CalendarData = { events: { '2026-08-11': ['Saved meeting'] } }
    const liveCalendar = document.createElement('div')
    liveCalendar.innerHTML =
      '<input data-srn-calendar-event-input="true" data-srn-calendar-event-date="2026-08-12" value="  Unsaved meeting  ">'

    const snapshot = applyLiveCalendarEdit(getCalendarPrintSnapshot(data), liveCalendar)

    expect(snapshot.events).toEqual([
      { date: '2026-08-11', text: 'Saved meeting' },
      { date: '2026-08-12', text: 'Unsaved meeting' },
    ])
    expect(data.events).toEqual({ '2026-08-11': ['Saved meeting'] })
  })
})
