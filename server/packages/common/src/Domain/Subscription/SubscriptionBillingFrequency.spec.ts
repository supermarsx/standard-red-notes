import { SubscriptionBillingFrequency } from './SubscriptionBillingFrequency'

describe('SubscriptionBillingFrequency', () => {
  it('should encode each billing frequency as its length in months', () => {
    expect(SubscriptionBillingFrequency.Monthly).toEqual(1)
    expect(SubscriptionBillingFrequency.Annual).toEqual(12)
    expect(SubscriptionBillingFrequency.FiveYear).toEqual(60)
  })

  it('should expose exactly the three supported billing frequencies', () => {
    const numericValues = Object.values(SubscriptionBillingFrequency).filter((value) => typeof value === 'number')

    expect(numericValues.sort((a, b) => (a as number) - (b as number))).toEqual([1, 12, 60])
  })

  it('should reverse-map each month count back to its frequency name', () => {
    expect(SubscriptionBillingFrequency[1]).toEqual('Monthly')
    expect(SubscriptionBillingFrequency[12]).toEqual('Annual')
    expect(SubscriptionBillingFrequency[60]).toEqual('FiveYear')
  })
})
