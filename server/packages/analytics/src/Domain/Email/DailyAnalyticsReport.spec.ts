import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { getBody, getSubject } from './DailyAnalyticsReport'
import { html } from './daily-analytics-report.html'

jest.mock('./daily-analytics-report.html', () => ({
  html: jest.fn().mockReturnValue('<div>report</div>'),
}))

describe('DailyAnalyticsReport', () => {
  let timer: TimerInterface

  beforeEach(() => {
    jest.clearAllMocks()
    timer = {} as jest.Mocked<TimerInterface>
  })

  it('subjects the email with the month-first date of the day it is sent', () => {
    jest.useFakeTimers().setSystemTime(new Date('2023-04-05T12:00:00.000Z'))
    const now = new Date()

    expect(getSubject()).toEqual(
      `Daily analytics report ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`,
    )

    jest.useRealTimers()
  })

  it('renders the body from the report template with the supplied data and timer', () => {
    const data = { statisticMeasures: [] }

    expect(getBody(data, timer)).toEqual('<div>report</div>')
    expect(html).toHaveBeenCalledWith(data, timer)
  })
})
