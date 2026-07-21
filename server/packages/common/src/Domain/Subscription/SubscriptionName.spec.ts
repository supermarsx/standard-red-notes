import { SubscriptionName } from './SubscriptionName'

describe('SubscriptionName', () => {
  it('should serialize each subscription name to its wire value', () => {
    expect(SubscriptionName.PlusPlan).toEqual('PLUS_PLAN')
    expect(SubscriptionName.ProPlan).toEqual('PRO_PLAN')
  })

  it('should expose exactly the two subscription plans', () => {
    expect(Object.values(SubscriptionName).sort()).toEqual(['PLUS_PLAN', 'PRO_PLAN'])
  })
})
