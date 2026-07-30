/* eslint-disable @typescript-eslint/no-explicit-any */
import { TimerInterface } from '@standardnotes/time'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { Period } from '../Time/Period'

import { safeHtml } from '@standardnotes/common'

const unavailable = 'N/A'

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : [])

const asFiniteNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const formatNumber = (value: unknown): string => asFiniteNumber(value)?.toLocaleString('en-US') ?? unavailable

const formatCurrency = (value: unknown): string => {
  const amount = asFiniteNumber(value)

  return amount === undefined ? unavailable : `$${amount.toLocaleString('en-US')}`
}

const formatPercentage = (value: unknown): string => {
  const percentage = asFiniteNumber(value)

  return percentage === undefined ? unavailable : `${Math.floor(percentage)}%`
}

const formatDuration = (timer: TimerInterface, value: unknown): string => {
  const microseconds = asFiniteNumber(value)
  if (microseconds === undefined) {
    return unavailable
  }

  const duration = timer.convertMicrosecondsToTimeStructure(Math.floor(microseconds))

  return `${duration.days} days ${duration.hours} hours ${duration.minutes} minutes`
}

const latestTotalCount = (measurement: any): number | undefined => {
  const counts = asArray(measurement?.counts)

  return asFiniteNumber(counts.at(-1)?.totalCount)
}

const countActiveUsers = (
  measureName: string,
  statisticsOverTime: any[],
): { yesterday: number | undefined; last30Days: number | undefined } => {
  const totalActiveUsersLast30DaysIncludingToday = statisticsOverTime.find(
    (a: { name: string; period: number }) => a.name === measureName && a.period === Period.Last30DaysIncludingToday,
  )

  const counts = asArray(totalActiveUsersLast30DaysIncludingToday?.counts)
  const totalActiveUsersYesterday = asFiniteNumber(counts.at(-2)?.totalCount)

  const validCounts = counts.flatMap((count: { totalCount?: unknown }) => {
    const totalCount = asFiniteNumber(count.totalCount)

    return totalCount === undefined ? [] : [totalCount]
  })
  const nonZeroCounts = validCounts.filter((totalCount: number) => totalCount !== 0)
  if (validCounts.length === 0) {
    return {
      yesterday: totalActiveUsersYesterday,
      last30Days: undefined,
    }
  }
  const averageActiveUsersLast30Days =
    nonZeroCounts.length === 0
      ? 0
      : Math.floor(
          nonZeroCounts.reduce((previousValue: number, currentValue: number) => previousValue + currentValue, 0) /
            nonZeroCounts.length,
        )

  return {
    yesterday: totalActiveUsersYesterday,
    last30Days: averageActiveUsersLast30Days,
  }
}

const getChartUrls = (
  data: any,
): {
  subscriptions: string
  users: string
  quarterlyPerformance: string
  churn: string
  mrrMonthly: string
} => {
  const activityStatisticsOverTime = asArray(data?.activityStatisticsOverTime)
  const statisticsOverTime = asArray(data?.statisticsOverTime)
  const churnValues = asArray(data?.churn?.values)

  const subscriptionPurchasingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionPurchased && a.period === Period.Last30Days,
  )
  const subscriptionRenewingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionRenewed && a.period === Period.Last30Days,
  )
  const subscriptionRefundingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionRefunded && a.period === Period.Last30Days,
  )
  const subscriptionCancelledOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionCancelled && a.period === Period.Last30Days,
  )
  const subscriptionReactivatedOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionReactivated && a.period === Period.Last30Days,
  )

  const subscriptionsLinerOverTimeConfig = {
    type: 'line',
    data: {
      labels: asArray(subscriptionPurchasingOverTime?.counts).map((count: { periodKey: any }) => count.periodKey),
      datasets: [
        {
          label: 'Subscription Purchases',
          backgroundColor: 'rgb(25, 255, 140)',
          borderColor: 'rgb(25, 255, 140)',
          data: asArray(subscriptionPurchasingOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
        {
          label: 'Subscription Renewals',
          backgroundColor: 'rgb(54, 162, 235)',
          borderColor: 'rgb(54, 162, 235)',
          data: asArray(subscriptionRenewingOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
        {
          label: 'Subscription Refunds',
          backgroundColor: 'rgb(255, 221, 51)',
          borderColor: 'rgb(255, 221, 51)',
          data: asArray(subscriptionRefundingOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
        {
          label: 'Subscription Cancels',
          backgroundColor: 'rgb(255, 99, 132)',
          borderColor: 'rgb(255, 99, 132)',
          data: asArray(subscriptionCancelledOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
        {
          label: 'Subscription Reactivations',
          backgroundColor: 'rgb(221, 51, 255)',
          borderColor: 'rgb(221, 51, 255)',
          data: asArray(subscriptionReactivatedOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
      ],
    },
  }

  const userRegistrationOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.Register && a.period === Period.Last30Days,
  )
  const userDeletionOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.DeleteAccount && a.period === Period.Last30Days,
  )

  const usersLinerOverTimeConfig = {
    type: 'line',
    data: {
      labels: asArray(userRegistrationOverTime?.counts).map((count: { periodKey: any }) => count.periodKey),
      datasets: [
        {
          label: 'User Registrations',
          backgroundColor: 'rgb(25, 255, 140)',
          borderColor: 'rgb(25, 255, 140)',
          data: asArray(userRegistrationOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
        {
          label: 'Account Deletions',
          backgroundColor: 'rgb(255, 99, 132)',
          borderColor: 'rgb(255, 99, 132)',
          data: asArray(userDeletionOverTime?.counts).map((count: { totalCount: any }) => count.totalCount),
          fill: false,
          pointRadius: 2,
        },
      ],
    },
  }

  const quarters = [Period.Q1ThisYear, Period.Q2ThisYear, Period.Q3ThisYear, Period.Q4ThisYear]
  const quarterlyUserRegistrations = []
  const quarterlySubscriptionPurchases = []
  const quarterlySubscriptionRenewals = []
  for (const quarter of quarters) {
    const registrations =
      activityStatisticsOverTime.find(
        (a: { name: AnalyticsActivity; period: Period }) =>
          a.name === AnalyticsActivity.Register && a.period === quarter,
      )?.totalCount ?? 0
    const purchases =
      activityStatisticsOverTime.find(
        (a: { name: AnalyticsActivity; period: Period }) =>
          a.name === AnalyticsActivity.SubscriptionPurchased && a.period === quarter,
      )?.totalCount ?? 0
    const renewals =
      activityStatisticsOverTime.find(
        (a: { name: AnalyticsActivity; period: Period }) =>
          a.name === AnalyticsActivity.SubscriptionRenewed && a.period === quarter,
      )?.totalCount ?? 0
    quarterlyUserRegistrations.push(registrations)
    quarterlySubscriptionPurchases.push(purchases)
    quarterlySubscriptionRenewals.push(renewals)
  }

  const quarterlyConfig = {
    type: 'bar',
    data: {
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      datasets: [
        {
          label: 'User Registrations',
          backgroundColor: 'rgba(255, 99, 132, 0.5)',
          borderColor: 'rgb(255, 99, 132)',
          borderWidth: 1,
          data: quarterlyUserRegistrations,
        },
        {
          label: 'Subscription Purchases',
          backgroundColor: 'rgba(54, 162, 235, 0.5)',
          borderColor: 'rgb(54, 162, 235)',
          borderWidth: 1,
          data: quarterlySubscriptionPurchases,
        },
        {
          label: 'Subscription Renewals',
          backgroundColor: 'rgb(25, 255, 140, 0.5)',
          borderColor: 'rgb(25, 255, 140)',
          borderWidth: 1,
          data: quarterlySubscriptionRenewals,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: 'Quarterly Performance',
      },
      plugins: {
        datalabels: {
          anchor: 'center',
          align: 'center',
          color: '#666',
          font: {
            weight: 'normal',
          },
        },
      },
    },
  }

  const monthlyChurnRates = churnValues.flatMap((value: { rate?: unknown }) => {
    const rate = asFiniteNumber(value.rate)

    return rate === undefined ? [] : [+rate.toFixed(2)]
  })

  const churnConfig = {
    type: 'bar',
    data: {
      labels: [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ],
      datasets: [
        {
          label: 'Churn Percent',
          backgroundColor: 'rgba(255, 99, 132, 0.5)',
          borderColor: 'rgb(255, 99, 132)',
          borderWidth: 1,
          data: monthlyChurnRates,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: 'Monthly Churn Rate',
      },
      plugins: {
        datalabels: {
          anchor: 'center',
          align: 'center',
          color: '#666',
          font: {
            weight: 'normal',
          },
        },
      },
    },
  }

  const mrrThisYear = statisticsOverTime.find(
    (a: { name: string; period: Period }) => a.name === 'mrr' && a.period === Period.ThisYear,
  )
  const mrrMonthlyOverTime = asArray(mrrThisYear?.counts).flatMap((count: { totalCount?: unknown }) => {
    const totalCount = asFiniteNumber(count.totalCount)

    return totalCount === undefined ? [] : [+totalCount.toFixed(2)]
  })

  const mrrMonthlyConfig = {
    type: 'bar',
    data: {
      labels: [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ],
      datasets: [
        {
          label: 'MRR',
          backgroundColor: 'rgba(25, 255, 140, 0.5)',
          borderColor: 'rgb(25, 255, 140)',
          borderWidth: 1,
          data: mrrMonthlyOverTime,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: 'Monthly MRR',
      },
      plugins: {
        datalabels: {
          anchor: 'center',
          align: 'center',
          color: '#666',
          font: {
            weight: 'normal',
          },
        },
      },
    },
  }

  return {
    subscriptions: `https://quickchart.io/chart?width=800&c=${encodeURIComponent(
      JSON.stringify(subscriptionsLinerOverTimeConfig),
    )}`,
    users: `https://quickchart.io/chart?width=800&c=${encodeURIComponent(JSON.stringify(usersLinerOverTimeConfig))}`,
    quarterlyPerformance: `https://quickchart.io/chart?width=800&c=${encodeURIComponent(
      JSON.stringify(quarterlyConfig),
    )}`,
    churn: `https://quickchart.io/chart?width=800&c=${encodeURIComponent(JSON.stringify(churnConfig))}`,
    mrrMonthly: `https://quickchart.io/chart?width=800&c=${encodeURIComponent(JSON.stringify(mrrMonthlyConfig))}`,
  }
}

export const html = (data: any, timer: TimerInterface) => {
  const activityStatistics = asArray(data?.activityStatistics)
  const activityStatisticsOverTime = asArray(data?.activityStatisticsOverTime)
  const statisticMeasures = asArray(data?.statisticMeasures)
  const statisticsOverTime = asArray(data?.statisticsOverTime)
  const churnValues = asArray(data?.churn?.values)
  const chartUrls = getChartUrls({
    activityStatisticsOverTime,
    statisticsOverTime,
    churn: {
      values: churnValues,
    },
  })

  const successfulPaymentsActivity = activityStatistics.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.PaymentSuccess && a.period === Period.Yesterday,
  )
  const failedPaymentsActivity = activityStatistics.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.PaymentFailed && a.period === Period.Yesterday,
  )
  const limitedDiscountPurchasedActivity = activityStatistics.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.LimitedDiscountOfferPurchased && a.period === Period.Yesterday,
  )
  const subscriptionPurchasingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionPurchased && a.period === Period.Last30Days,
  )
  const subscriptionRenewingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionRenewed && a.period === Period.Last30Days,
  )
  const subscriptionRefundingOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionRefunded && a.period === Period.Last30Days,
  )
  const subscriptionCancelledOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionCancelled && a.period === Period.Last30Days,
  )
  const subscriptionReactivatedOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.SubscriptionReactivated && a.period === Period.Last30Days,
  )
  const userRegistrationOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.Register && a.period === Period.Last30Days,
  )
  const userDeletionOverTime = activityStatisticsOverTime.find(
    (a: { name: AnalyticsActivity; period: Period }) =>
      a.name === AnalyticsActivity.DeleteAccount && a.period === Period.Last30Days,
  )
  const incomeMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.Income && a.period === Period.Yesterday,
  )
  const refundMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.Refunds && a.period === Period.Yesterday,
  )
  const incomeYesterday = asFiniteNumber(incomeMeasureYesterday?.totalValue)
  const refundsYesterday = asFiniteNumber(refundMeasureYesterday?.totalValue)
  const revenueYesterday =
    incomeYesterday === undefined || refundsYesterday === undefined ? undefined : incomeYesterday - refundsYesterday

  const subscriptionLengthMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.SubscriptionLength && a.period === Period.Yesterday,
  )
  const subscriptionLengthDurationYesterday = formatDuration(timer, subscriptionLengthMeasureYesterday?.average)

  const subscriptionRemainingTimePercentageMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage && a.period === Period.Yesterday,
  )
  const subscriptionRemainingTimePercentageYesterday = formatPercentage(
    subscriptionRemainingTimePercentageMeasureYesterday?.average,
  )

  const registrationLengthMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RegistrationLength && a.period === Period.Yesterday,
  )
  const registrationLengthDurationYesterday = formatDuration(timer, registrationLengthMeasureYesterday?.average)

  const registrationToSubscriptionMeasureYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RegistrationToSubscriptionTime && a.period === Period.Yesterday,
  )
  const registrationToSubscriptionDurationYesterday = formatDuration(
    timer,
    registrationToSubscriptionMeasureYesterday?.average,
  )

  const incomeMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.Income && a.period === Period.ThisMonth,
  )
  const refundMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.Refunds && a.period === Period.ThisMonth,
  )
  const incomeThisMonth = asFiniteNumber(incomeMeasureThisMonth?.totalValue)
  const refundsThisMonth = asFiniteNumber(refundMeasureThisMonth?.totalValue)
  const revenueThisMonth =
    incomeThisMonth === undefined || refundsThisMonth === undefined ? undefined : incomeThisMonth - refundsThisMonth

  const subscriptionLengthMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.SubscriptionLength && a.period === Period.ThisMonth,
  )
  const subscriptionLengthDurationThisMonth = formatDuration(timer, subscriptionLengthMeasureThisMonth?.average)

  const subscriptionRemainingTimePercentageMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RemainingSubscriptionTimePercentage && a.period === Period.ThisMonth,
  )
  const subscriptionRemainingTimePercentageThisMonth = formatPercentage(
    subscriptionRemainingTimePercentageMeasureThisMonth?.average,
  )

  const registrationLengthMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RegistrationLength && a.period === Period.ThisMonth,
  )
  const registrationLengthDurationThisMonth = formatDuration(timer, registrationLengthMeasureThisMonth?.average)

  const registrationToSubscriptionMeasureThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.RegistrationToSubscriptionTime && a.period === Period.ThisMonth,
  )
  const registrationToSubscriptionDurationThisMonth = formatDuration(
    timer,
    registrationToSubscriptionMeasureThisMonth?.average,
  )

  const plusSubscriptionsInitialAnnualPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionInitialAnnualPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const plusSubscriptionsInitialMonthlyPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionInitialMonthlyPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const plusSubscriptionsRenewingAnnualPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionRenewingAnnualPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const plusSubscriptionsRenewingMonthlyPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionRenewingMonthlyPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const proSubscriptionsInitialAnnualPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionInitialAnnualPaymentsIncome && a.period === Period.Yesterday,
  )
  const proSubscriptionsInitialMonthlyPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionInitialMonthlyPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const proSubscriptionsRenewingAnnualPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionRenewingAnnualPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const proSubscriptionsRenewingMonthlyPaymentsYesterday = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionRenewingMonthlyPaymentsIncome &&
      a.period === Period.Yesterday,
  )
  const plusSubscriptionsInitialAnnualPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionInitialAnnualPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const plusSubscriptionsInitialMonthlyPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionInitialMonthlyPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const plusSubscriptionsRenewingAnnualPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionRenewingAnnualPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const plusSubscriptionsRenewingMonthlyPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.PlusSubscriptionRenewingMonthlyPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const proSubscriptionsInitialAnnualPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionInitialAnnualPaymentsIncome && a.period === Period.ThisMonth,
  )
  const proSubscriptionsInitialMonthlyPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionInitialMonthlyPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const proSubscriptionsRenewingAnnualPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionRenewingAnnualPaymentsIncome &&
      a.period === Period.ThisMonth,
  )
  const proSubscriptionsRenewingMonthlyPaymentsThisMonth = statisticMeasures.find(
    (a: { name: string; period: Period }) =>
      a.name === StatisticMeasureName.NAMES.ProSubscriptionRenewingMonthlyPaymentsIncome &&
      a.period === Period.ThisMonth,
  )

  const mrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) => a.name === 'mrr' && a.period === Period.Last30DaysIncludingToday,
  )
  const monthlyPlansMrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) =>
      a.name === 'monthly-plans-mrr' && a.period === Period.Last30DaysIncludingToday,
  )
  const annualPlansMrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) =>
      a.name === 'annual-plans-mrr' && a.period === Period.Last30DaysIncludingToday,
  )
  const fiveYearPlansMrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) =>
      a.name === 'five-year-plans-mrr' && a.period === Period.Last30DaysIncludingToday,
  )
  const proPlansMrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) => a.name === 'pro-plans-mrr' && a.period === Period.Last30DaysIncludingToday,
  )
  const plusPlansMrrOverTime = statisticsOverTime.find(
    (a: { name: string; period: number }) =>
      a.name === 'plus-plans-mrr' && a.period === Period.Last30DaysIncludingToday,
  )

  const today = new Date()
  const thisMonthPeriodKey = `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}`
  const thisMonthChurn = churnValues.find((value: { periodKey: string }) => value.periodKey === thisMonthPeriodKey)

  const totalActiveUsers = countActiveUsers(StatisticMeasureName.NAMES.ActiveUsers, statisticsOverTime)
  const totalActiveFreeUsers = countActiveUsers(StatisticMeasureName.NAMES.ActiveFreeUsers, statisticsOverTime)
  const totalActivePlusUsers = countActiveUsers(StatisticMeasureName.NAMES.ActivePlusUsers, statisticsOverTime)
  const totalActiveProUsers = countActiveUsers(StatisticMeasureName.NAMES.ActiveProUsers, statisticsOverTime)

  return safeHtml`      <div>
<p>Hello,</p>
<p>
  <strong>Here are some statistics from yesterday:</strong>
</p>
<ul>
  <li>
    <b>Active Users</b>
    <ul>
      <li>
        <b>Total:</b> ${formatNumber(totalActiveUsers.yesterday)}
      </li>
      <li>
        <b>By Subscription Type:</b>
        <ul>
          <li>
            <b>FREE:</b> ${formatNumber(totalActiveFreeUsers.yesterday)}
          </li>
          <li>
            <b>PLUS:</b> ${formatNumber(totalActivePlusUsers.yesterday)}
          </li>
          <li>
            <b>PRO:</b> ${formatNumber(totalActiveProUsers.yesterday)}
          </li>
        </ul>
      </li>
    </ul>
  </li>
  <li>
    <b>Payments</b>
    <ul>
      <li>
        Revenue: <b>${formatCurrency(revenueYesterday)}</b> (Income:
        ${formatCurrency(incomeYesterday)}, Refunds: ${formatCurrency(refundsYesterday)})
      </li>
      <li>
        Successful payments: <b>${formatNumber(successfulPaymentsActivity?.totalCount)}</b>
      </li>
      <li>
        Failed payments: <b>${formatNumber(failedPaymentsActivity?.totalCount)}</b>
      </li>
    </ul>
  </li>
  <li>
    <b>MRR Breakdown</b>
    <ul>
      <li>
        <b>Total:</b> ${formatCurrency(latestTotalCount(mrrOverTime))}
      </li>
      <li>
        <b>By Subscription Type:</b>
        <ul>
          <li>
            <b>PLUS:</b>
            ${formatCurrency(latestTotalCount(plusPlansMrrOverTime))}
          </li>
          <li>
            <b>PRO:</b>
            ${formatCurrency(latestTotalCount(proPlansMrrOverTime))}
          </li>
        </ul>
      </li>
      <li>
        <b>By Billing Frequency:</b>
        <ul>
          <li>
            <b>Monthly:</b>
            ${formatCurrency(latestTotalCount(monthlyPlansMrrOverTime))}
          </li>
          <li>
            <b>Annual:</b>
            ${formatCurrency(latestTotalCount(annualPlansMrrOverTime))}
          </li>
          <li>
            <b>5-year:</b>
            ${formatCurrency(latestTotalCount(fiveYearPlansMrrOverTime))}
          </li>
        </ul>
      </li>
    </ul>
  </li>
  <li>
    <b>Income Breakdown</b>
    <ul>
      <li>
        <b>Plus Subscription:</b>
        <ul>
          <li>
            <b>${formatNumber(plusSubscriptionsInitialMonthlyPaymentsYesterday?.increments)}</b>${' '}
            <i>initial</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsInitialMonthlyPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsInitialAnnualPaymentsYesterday?.increments)}</b>${' '}
            <i>initial</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsInitialAnnualPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsRenewingMonthlyPaymentsYesterday?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsRenewingMonthlyPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsRenewingAnnualPaymentsYesterday?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsRenewingAnnualPaymentsYesterday?.totalValue)}</b>
          </li>
        </ul>
      </li>
      <li>
        <b>Pro Subscription:</b>
        <ul>
          <li>
            <b>${formatNumber(proSubscriptionsInitialMonthlyPaymentsYesterday?.increments)}</b>${' '}
            <i>initial</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsInitialMonthlyPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsInitialAnnualPaymentsYesterday?.increments)}</b>${' '}
            <i>initial</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsInitialAnnualPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsRenewingMonthlyPaymentsYesterday?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsRenewingMonthlyPaymentsYesterday?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsRenewingAnnualPaymentsYesterday?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsRenewingAnnualPaymentsYesterday?.totalValue)}</b>
          </li>
        </ul>
      </li>
    </ul>
  </li>
  <li>
    <b>Users</b>
    <ul>
      <li>
        Number of users registered:${' '}
        <b>
          ${formatNumber(latestTotalCount(userRegistrationOverTime))}
        </b>
      </li>
      <li>
        Number of users unregistered:${' '}
        <b>
          ${formatNumber(latestTotalCount(userDeletionOverTime))}
        </b>${' '}
        (average account duration: ${registrationLengthDurationYesterday})
      </li>
    </ul>
  </li>
  <li>
    <b>Subscriptions</b>
    <ul>
      <li>
        Number of subscriptions purchased:${' '}
        <b>
          ${formatNumber(latestTotalCount(subscriptionPurchasingOverTime))}
        </b>${' '}
        (includes <b>${formatNumber(limitedDiscountPurchasedActivity?.totalCount)}</b> limited time
        offer purchases)
      </li>
      <li>
        Number of subscriptions renewed:${' '}
        <b>
          ${formatNumber(latestTotalCount(subscriptionRenewingOverTime))}
        </b>
      </li>
      <li>
        Number of subscriptions refunded:${' '}
        <b>
          ${formatNumber(latestTotalCount(subscriptionRefundingOverTime))}
        </b>
      </li>
      <li>
        Number of subscriptions cancelled:${' '}
        <b>
          ${formatNumber(latestTotalCount(subscriptionCancelledOverTime))}
        </b>${' '}
        (average subscription duration: ${subscriptionLengthDurationYesterday},
        average remaining subscription percentage: ${subscriptionRemainingTimePercentageYesterday})
      </li>
      <li>
        Number of subscriptions reactivated:${' '}
        <b>
          ${formatNumber(latestTotalCount(subscriptionReactivatedOverTime))}
        </b>
      </li>
      <li>
        Average time from registration to subscription purchase:${' '}
        <b>${registrationToSubscriptionDurationYesterday}</b>
      </li>
    </ul>
  </li>
</ul>
<p>
  <strong>Here are some statistics from last 30 days:</strong>
</p>
<ul>
  <li>
    <b>Active Users (Average)</b>
    <ul>
      <li>
        <b>Total:</b> ${formatNumber(totalActiveUsers.last30Days)}
      </li>
      <li>
        <b>By Subscription Type:</b>
        <ul>
          <li>
            <b>FREE:</b> ${formatNumber(totalActiveFreeUsers.last30Days)}
          </li>
          <li>
            <b>PLUS:</b> ${formatNumber(totalActivePlusUsers.last30Days)}
          </li>
          <li>
            <b>PRO:</b> ${formatNumber(totalActiveProUsers.last30Days)}
          </li>
        </ul>
      </li>
    </ul>
  </li>
  <li>
    <b>Payments (This Month)</b>
    <ul>
      <li>
        Revenue: <b>${formatCurrency(revenueThisMonth)}</b>
      </li>
      <li>
        Income: <b>${formatCurrency(incomeThisMonth)}</b>
      </li>
      <li>
        Refunds: <b>${formatCurrency(refundsThisMonth)}</b>
      </li>
    </ul>
  </li>
  <li>
    <b>Income Breakdown (This Month)</b>
    <ul>
      <li>
        <b>Plus Subscription:</b>
        <ul>
          <li>
            <b>${formatNumber(plusSubscriptionsInitialMonthlyPaymentsThisMonth?.increments)}</b>${' '}
            <i>initial</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsInitialMonthlyPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsInitialAnnualPaymentsThisMonth?.increments)}</b>${' '}
            <i>initial</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsInitialAnnualPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsRenewingMonthlyPaymentsThisMonth?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsRenewingMonthlyPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(plusSubscriptionsRenewingAnnualPaymentsThisMonth?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(plusSubscriptionsRenewingAnnualPaymentsThisMonth?.totalValue)}</b>
          </li>
        </ul>
      </li>
      <li>
        <b>Pro Subscription:</b>
        <ul>
          <li>
            <b>${formatNumber(proSubscriptionsInitialMonthlyPaymentsThisMonth?.increments)}</b>${' '}
            <i>initial</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsInitialMonthlyPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsInitialAnnualPaymentsThisMonth?.increments)}</b>${' '}
            <i>initial</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsInitialAnnualPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsRenewingMonthlyPaymentsThisMonth?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>monthly</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsRenewingMonthlyPaymentsThisMonth?.totalValue)}</b>
          </li>
          <li>
            <b>${formatNumber(proSubscriptionsRenewingAnnualPaymentsThisMonth?.increments)}</b>${' '}
            <i>renewing</i> payments on <u>annual</u> plan, totaling${' '}
            <b>${formatCurrency(proSubscriptionsRenewingAnnualPaymentsThisMonth?.totalValue)}</b>
          </li>
        </ul>
      </li>
    </ul>
  </li>
  <li>
    <b>Users</b>
    <ul>
      <li>
        Number of users registered: <b>${formatNumber(userRegistrationOverTime?.totalCount)}</b>
      </li>
      <li>
        Number of users unregistered: <b>${formatNumber(userDeletionOverTime?.totalCount)}</b>
      </li>
      <li>
        Average account duration this month:${' '}
        <b>${registrationLengthDurationThisMonth}</b>
      </li>
    </ul>
  </li>
  <li>
    <b>Subscriptions</b>
    <ul>
      <li>
        Number of subscriptions purchased:${' '}
        <b>${formatNumber(subscriptionPurchasingOverTime?.totalCount)}</b>
      </li>
      <li>
        Number of subscriptions renewed:${' '}
        <b>${formatNumber(subscriptionRenewingOverTime?.totalCount)}</b>
      </li>
      <li>
        Number of subscriptions refunded:${' '}
        <b>${formatNumber(subscriptionRefundingOverTime?.totalCount)}</b>
      </li>
      <li>
        Number of subscriptions cancelled:${' '}
        <b>${formatNumber(subscriptionCancelledOverTime?.totalCount)}</b>
      </li>
      <li>
        Number of subscriptions reactivated:${' '}
        <b>${formatNumber(subscriptionReactivatedOverTime?.totalCount)}</b>
      </li>
      <li>
        Average subscription duration this month:${' '}
        <b>${subscriptionLengthDurationThisMonth}</b>
      </li>
      <li>
        Average subscription remaining percentage this month:${' '}
        <b>${subscriptionRemainingTimePercentageThisMonth}</b>
      </li>
      <li>
        Average time from registration to subscription purchase this month:${' '}
        <b>${registrationToSubscriptionDurationThisMonth}</b>
      </li>
    </ul>
  </li>
</ul>
<p>
  <strong>Here is the MRR Monthly chart this year:</strong>
</p>
<img src=${chartUrls.mrrMonthly}></img>
<p>
  <strong>Here is the subscription chart over 30 days:</strong>
</p>
<img src=${chartUrls.subscriptions}></img>
<p>
  <strong>Here is the users chart over 30 days:</strong>
</p>
<img src=${chartUrls.users}></img>
<p>
  <strong>Here is the monthly churn rate percentage:</strong>
</p>
<p>✅ GREAT! Up to 7% 🔶 OKAY: 8-10% 🩸 BAD: 11 -15 % 🚨 TERRIBLE! 16-20%</p>
<p>Churn is calculated by the following formula:</p>
<p>
  ( Existing Customers Churn [${formatNumber(thisMonthChurn?.existingCustomersChurn)}] + New Customers Churn [
  ${formatNumber(thisMonthChurn?.newCustomersChurn)}] ) * 100 / Average Customers Count This Month [
  ${formatNumber(thisMonthChurn?.averageCustomersCount)}]
</p>
<img src=${chartUrls.churn}></img>
<p>
  <strong>Here is quarterly performance chart:</strong>
</p>
<img src=${chartUrls.quarterlyPerformance}></img>
<p>Thanks,SN</p>
</div>`
}
