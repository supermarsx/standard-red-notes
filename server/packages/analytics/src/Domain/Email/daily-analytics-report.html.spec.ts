import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { Period } from '../Time/Period'

import { html } from './daily-analytics-report.html'

const LAST_30_DAYS_INCLUDING_TODAY = 27

type ReportData = {
  statisticsOverTime: unknown[]
  activityStatisticsOverTime: unknown[]
  activityStatistics: unknown[]
  statisticMeasures: unknown[]
  churn: { values: unknown[] }
}

const activeUserCounts = (values: number[]) =>
  values.map((totalCount, index) => ({ periodKey: `2023-1-${index + 1}`, totalCount }))

const measure = (
  name: string,
  period: Period,
  values: { totalValue?: number; average?: number; increments?: number },
) => ({
  name,
  period,
  totalValue: 0,
  average: 0,
  increments: 0,
  ...values,
})

const INCOME_MEASURE_NAMES = [
  StatisticMeasureName.NAMES.PlusSubscriptionInitialAnnualPaymentsIncome,
  StatisticMeasureName.NAMES.PlusSubscriptionInitialMonthlyPaymentsIncome,
  StatisticMeasureName.NAMES.PlusSubscriptionRenewingAnnualPaymentsIncome,
  StatisticMeasureName.NAMES.PlusSubscriptionRenewingMonthlyPaymentsIncome,
  StatisticMeasureName.NAMES.ProSubscriptionInitialAnnualPaymentsIncome,
  StatisticMeasureName.NAMES.ProSubscriptionInitialMonthlyPaymentsIncome,
  StatisticMeasureName.NAMES.ProSubscriptionRenewingAnnualPaymentsIncome,
  StatisticMeasureName.NAMES.ProSubscriptionRenewingMonthlyPaymentsIncome,
]

const OVER_TIME_ACTIVITIES = [
  AnalyticsActivity.SubscriptionPurchased,
  AnalyticsActivity.SubscriptionRenewed,
  AnalyticsActivity.SubscriptionRefunded,
  AnalyticsActivity.SubscriptionCancelled,
  AnalyticsActivity.SubscriptionReactivated,
  AnalyticsActivity.Register,
  AnalyticsActivity.DeleteAccount,
]

const buildData = (): ReportData => {
  const statisticsOverTime: unknown[] = [
    {
      name: StatisticMeasureName.NAMES.ActiveUsers,
      period: LAST_30_DAYS_INCLUDING_TODAY,
      counts: activeUserCounts([0, 10, 20, 33]),
    },
    {
      name: StatisticMeasureName.NAMES.ActiveFreeUsers,
      period: LAST_30_DAYS_INCLUDING_TODAY,
      counts: activeUserCounts([5, 6, 7, 8]),
    },
    {
      name: StatisticMeasureName.NAMES.ActivePlusUsers,
      period: LAST_30_DAYS_INCLUDING_TODAY,
      counts: activeUserCounts([1, 2, 3, 4]),
    },
    {
      name: StatisticMeasureName.NAMES.ActiveProUsers,
      period: LAST_30_DAYS_INCLUDING_TODAY,
      counts: activeUserCounts([2, 4, 6, 8]),
    },
    { name: 'mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([100, 200, 300]) },
    { name: 'monthly-plans-mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([10, 20, 30]) },
    { name: 'annual-plans-mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([40, 50, 60]) },
    { name: 'five-year-plans-mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([1, 2, 3]) },
    { name: 'pro-plans-mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([70, 80, 90]) },
    { name: 'plus-plans-mrr', period: LAST_30_DAYS_INCLUDING_TODAY, counts: activeUserCounts([15, 25, 35]) },
    {
      name: 'mrr',
      period: Period.ThisYear,
      counts: [{ periodKey: '2023-1', totalCount: 1234.567 }],
    },
  ]

  const activityStatisticsOverTime: unknown[] = []
  for (const [index, name] of OVER_TIME_ACTIVITIES.entries()) {
    activityStatisticsOverTime.push({
      name,
      period: Period.Last30Days,
      totalCount: (index + 1) * 100,
      counts: [
        { periodKey: '2023-1-1', totalCount: index + 1 },
        { periodKey: '2023-1-2', totalCount: (index + 1) * 2 },
      ],
    })
  }
  for (const [quarterIndex, quarter] of [
    Period.Q1ThisYear,
    Period.Q2ThisYear,
    Period.Q3ThisYear,
    Period.Q4ThisYear,
  ].entries()) {
    activityStatisticsOverTime.push(
      { name: AnalyticsActivity.Register, period: quarter, totalCount: 1000 + quarterIndex },
      { name: AnalyticsActivity.SubscriptionPurchased, period: quarter, totalCount: 2000 + quarterIndex },
      { name: AnalyticsActivity.SubscriptionRenewed, period: quarter, totalCount: 3000 + quarterIndex },
    )
  }

  const statisticMeasures: unknown[] = [
    measure(StatisticMeasureName.NAMES.Income, Period.Yesterday, { totalValue: 1000 }),
    measure(StatisticMeasureName.NAMES.Refunds, Period.Yesterday, { totalValue: 250 }),
    measure(StatisticMeasureName.NAMES.Income, Period.ThisMonth, { totalValue: 9000 }),
    measure(StatisticMeasureName.NAMES.Refunds, Period.ThisMonth, { totalValue: 1500 }),
  ]
  for (const period of [Period.Yesterday, Period.ThisMonth]) {
    statisticMeasures.push(
      measure(StatisticMeasureName.NAMES.SubscriptionLength, period, { average: 172_800_000_000 }),
      measure(StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage, period, { average: 42.9 }),
      measure(StatisticMeasureName.NAMES.RegistrationLength, period, { average: 86_400_000_000 }),
      measure(StatisticMeasureName.NAMES.RegistrationToSubscriptionTime, period, { average: 3_600_000_000 }),
    )
    for (const [index, name] of INCOME_MEASURE_NAMES.entries()) {
      statisticMeasures.push(measure(name, period, { totalValue: (index + 1) * 10, increments: index + 1 }))
    }
  }

  const today = new Date()
  const thisMonthPeriodKey = `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}`

  return {
    statisticsOverTime,
    activityStatisticsOverTime,
    activityStatistics: [
      { name: AnalyticsActivity.PaymentSuccess, period: Period.ThisMonth, totalCount: 999 },
      { name: AnalyticsActivity.PaymentFailed, period: Period.ThisMonth, totalCount: 999 },
      { name: AnalyticsActivity.LimitedDiscountOfferPurchased, period: Period.ThisMonth, totalCount: 999 },
      { name: AnalyticsActivity.PaymentSuccess, period: Period.Yesterday, totalCount: 77 },
      { name: AnalyticsActivity.PaymentFailed, period: Period.Yesterday, totalCount: 8 },
      { name: AnalyticsActivity.LimitedDiscountOfferPurchased, period: Period.Yesterday, totalCount: 3 },
    ],
    statisticMeasures,
    churn: {
      values: [
        {
          periodKey: thisMonthPeriodKey,
          rate: 4.567,
          existingCustomersChurn: 11,
          newCustomersChurn: 4,
          averageCustomersCount: 300,
        },
      ],
    },
  }
}

// The template wraps long lines, so assertions on rendered prose compare collapsed whitespace.
const squash = (report: string) => report.replace(/\s+/g, ' ')

const chartConfigFrom = (report: string, index: number) => {
  const urls = [...report.matchAll(/<img src=(https:\/\/quickchart\.io\/chart\?width=800&amp;c=[^>]*)><\/img>/g)]

  return JSON.parse(decodeURIComponent(urls[index][1].split('c=')[1]))
}

describe('daily-analytics-report html', () => {
  let timer: TimerInterface
  let data: ReportData

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.convertMicrosecondsToTimeStructure = jest.fn().mockReturnValue({ days: 2, hours: 3, minutes: 4 })

    data = buildData()
  })

  it('reports yesterdays active users as the second to last daily count', () => {
    const report = html(data, timer)

    expect(report).toContain('<b>Total:</b> 20')
    expect(report).toContain('<b>FREE:</b> 7')
    expect(report).toContain('<b>PLUS:</b> 3')
    expect(report).toContain('<b>PRO:</b> 6')
  })

  it('averages the active users over the last 30 days ignoring days with no data', () => {
    const report = html(data, timer)

    // 10 + 20 + 33 == 63 over the three non-zero days, floored
    expect(report).toContain('<b>Total:</b> 21')
  })

  it('reports zero active users when every daily count is zero', () => {
    ;(data.statisticsOverTime as { name: string; counts: { totalCount: number }[] }[])[0].counts = activeUserCounts([
      0, 0, 0, 0,
    ])

    const report = html(data, timer)

    expect(report).toContain('<b>Total:</b> 0')
  })

  it('reports yesterdays revenue as income minus refunds', () => {
    const report = html(data, timer)

    expect(squash(report)).toContain('Revenue: <b>$750</b> (Income: $1,000, Refunds: $250)')
  })

  it('reports this months revenue as income minus refunds', () => {
    const report = html(data, timer)

    expect(report).toContain('Revenue: <b>$7,500</b>')
    expect(report).toContain('Income: <b>$9,000</b>')
    expect(report).toContain('Refunds: <b>$1,500</b>')
  })

  it('reports the payment activity counts from yesterday', () => {
    const report = html(data, timer)

    expect(report).toContain('Successful payments: <b>77</b>')
    expect(report).toContain('Failed payments: <b>8</b>')
  })

  it('reports the MRR breakdown from the most recent daily count', () => {
    const report = html(data, timer)

    expect(report).toContain('<b>Total:</b> $300')
    expect(squash(report)).toContain('<b>PLUS:</b> $35')
    expect(squash(report)).toContain('<b>PRO:</b> $90')
  })

  it('floors the average remaining subscription percentage', () => {
    const report = html(data, timer)

    expect(report).toContain('average remaining subscription percentage: 42%')
    expect(report).toContain('<b>42%</b>')
  })

  it('renders the durations returned by the timer', () => {
    const report = html(data, timer)

    expect(timer.convertMicrosecondsToTimeStructure).toHaveBeenCalledWith(86_400_000_000)
    expect(timer.convertMicrosecondsToTimeStructure).toHaveBeenCalledWith(172_800_000_000)
    expect(squash(report)).toContain('average account duration: 2 days 3 hours 4 minutes')
  })

  it('spells out the churn formula inputs for the current month', () => {
    const report = html(data, timer)

    expect(report).toContain('Existing Customers Churn [11]')
    expect(report).toContain('New Customers Churn [\n  4]')
    expect(report).toContain('Average Customers Count This Month [\n  300]')
  })

  it('renders five quickchart images', () => {
    const report = html(data, timer)

    expect([...report.matchAll(/<img src=https:\/\/quickchart\.io\/chart/g)]).toHaveLength(5)
  })

  it('plots the monthly MRR rounded to two decimals over twelve month labels', () => {
    const config = chartConfigFrom(html(data, timer), 0)

    expect(config.type).toEqual('bar')
    expect(config.options.title.text).toEqual('Monthly MRR')
    expect(config.data.labels).toHaveLength(12)
    expect(config.data.datasets[0].data).toEqual([1234.57])
  })

  it('plots five subscription lifecycle series over the last 30 days', () => {
    const config = chartConfigFrom(html(data, timer), 1)

    expect(config.type).toEqual('line')
    expect(config.data.labels).toEqual(['2023-1-1', '2023-1-2'])
    expect(config.data.datasets.map((dataset: { label: string }) => dataset.label)).toEqual([
      'Subscription Purchases',
      'Subscription Renewals',
      'Subscription Refunds',
      'Subscription Cancels',
      'Subscription Reactivations',
    ])
    expect(config.data.datasets[0].data).toEqual([1, 2])
    expect(config.data.datasets[4].data).toEqual([5, 10])
  })

  it('plots registrations against deletions over the last 30 days', () => {
    const config = chartConfigFrom(html(data, timer), 2)

    expect(config.data.datasets.map((dataset: { label: string }) => dataset.label)).toEqual([
      'User Registrations',
      'Account Deletions',
    ])
    expect(config.data.datasets[0].data).toEqual([6, 12])
    expect(config.data.datasets[1].data).toEqual([7, 14])
  })

  it('plots the monthly churn rate rounded to two decimals', () => {
    const config = chartConfigFrom(html(data, timer), 3)

    expect(config.options.title.text).toEqual('Monthly Churn Rate')
    expect(config.data.datasets[0].data).toEqual([4.57])
  })

  it('plots quarterly totals per quarter for registrations, purchases and renewals', () => {
    const config = chartConfigFrom(html(data, timer), 4)

    expect(config.data.labels).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
    expect(config.data.datasets[0].data).toEqual([1000, 1001, 1002, 1003])
    expect(config.data.datasets[1].data).toEqual([2000, 2001, 2002, 2003])
    expect(config.data.datasets[2].data).toEqual([3000, 3001, 3002, 3003])
  })

  it('falls back to zero for a quarter with no recorded activity', () => {
    data.activityStatisticsOverTime = (data.activityStatisticsOverTime as { period: Period }[]).filter(
      (entry) => entry.period !== Period.Q3ThisYear,
    )

    const config = chartConfigFrom(html(data, timer), 4)

    expect(config.data.datasets[0].data).toEqual([1000, 1001, 0, 1003])
    expect(config.data.datasets[1].data).toEqual([2000, 2001, 0, 2003])
    expect(config.data.datasets[2].data).toEqual([3000, 3001, 0, 3003])
  })

  it('renders unavailable values when there is no last-30-days activity at all', () => {
    data.activityStatisticsOverTime = (data.activityStatisticsOverTime as { period: Period }[]).filter(
      (entry) => entry.period !== Period.Last30Days,
    )

    const report = html(data, timer)

    expect(squash(report)).toContain('Number of subscriptions purchased: <b>N/A</b>')
    expect(squash(report)).toContain('Number of users registered: <b>N/A</b>')
    expect(chartConfigFrom(report, 1).data.datasets[0].data).toEqual([])
  })

  it('renders an empty MRR chart series when this year has no MRR statistics', () => {
    data.statisticsOverTime = (data.statisticsOverTime as { name: string; period: number }[]).filter(
      (entry) => !(entry.name === 'mrr' && entry.period === Period.ThisYear),
    )

    const config = chartConfigFrom(html(data, timer), 0)

    expect(config.data.datasets[0].data).toEqual([])
  })

  it('renders unavailable rather than zero when income or refund measures are missing', () => {
    data.statisticMeasures = (data.statisticMeasures as { name: string }[]).filter(
      (entry) => entry.name !== StatisticMeasureName.NAMES.Income && entry.name !== StatisticMeasureName.NAMES.Refunds,
    )

    const report = html(data, timer)

    expect(report).toContain('Revenue: <b>N/A</b>')
    expect(squash(report)).toContain('(Income: N/A, Refunds: N/A)')
    expect(timer.convertMicrosecondsToTimeStructure).toHaveBeenCalledWith(172_800_000_000)
  })

  it('renders unavailable without asking the timer to convert missing duration measures', () => {
    data.statisticMeasures = (data.statisticMeasures as { name: string }[]).filter(
      (entry) =>
        entry.name !== StatisticMeasureName.NAMES.SubscriptionLength &&
        entry.name !== StatisticMeasureName.NAMES.RegistrationLength &&
        entry.name !== StatisticMeasureName.NAMES.RegistrationToSubscriptionTime &&
        entry.name !== StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage,
    )

    const report = html(data, timer)

    expect(timer.convertMicrosecondsToTimeStructure).not.toHaveBeenCalled()
    expect(report).toContain('average subscription duration: N/A')
    expect(report).toContain('average remaining subscription percentage: N/A')
  })

  it('renders unavailable churn inputs when the current month has no churn entry', () => {
    data.churn.values = [
      { periodKey: '1999-1', rate: 1, existingCustomersChurn: 0, newCustomersChurn: 0, averageCustomersCount: 0 },
    ]

    const report = html(data, timer)

    expect(report).toContain('Existing Customers Churn [N/A]')
    expect(report).toContain('New Customers Churn [\n  N/A]')
    expect(report).toContain('Average Customers Count This Month [\n  N/A]')
  })

  it('renders unavailable values when a per-plan income measure is missing', () => {
    data.statisticMeasures = (data.statisticMeasures as { name: string }[]).filter(
      (entry) => !INCOME_MEASURE_NAMES.includes(entry.name),
    )

    const report = html(data, timer)

    expect(squash(report)).toContain('<b>N/A</b> <i>initial</i> payments on <u>monthly</u> plan')
    expect(squash(report)).toContain('plan, totaling <b>N/A</b>')
  })

  it('renders unavailable values when the payment activity counts are missing', () => {
    data.activityStatistics = []

    const report = html(data, timer)

    expect(report).toContain('Successful payments: <b>N/A</b>')
    expect(report).toContain('Failed payments: <b>N/A</b>')
  })

  it('renders unavailable values when the MRR breakdown is missing', () => {
    data.statisticsOverTime = (data.statisticsOverTime as { name: string }[]).filter(
      (entry) => !entry.name.includes('mrr'),
    )

    const report = html(data, timer)

    expect(report).toContain('<b>Total:</b> N/A')
    expect(squash(report)).toContain('<b>Monthly:</b> N/A')
  })

  it('renders unavailable active-user values when a measure has no daily counts', () => {
    ;(data.statisticsOverTime as { name: string; counts?: unknown[] }[]).find(
      (entry) => entry.name === StatisticMeasureName.NAMES.ActiveUsers,
    )!.counts = []

    const report = html(data, timer)

    expect(report).toContain('<b>Total:</b> N/A')
  })
})
