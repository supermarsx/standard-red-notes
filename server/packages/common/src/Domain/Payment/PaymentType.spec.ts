import { PaymentType } from './PaymentType'

describe('PaymentType', () => {
  it('should serialize each payment type to its wire value', () => {
    expect(PaymentType.Initial).toEqual('initial')
    expect(PaymentType.Renewal).toEqual('renewal')
  })

  it('should expose exactly the two payment types a subscription payment may have', () => {
    expect(Object.values(PaymentType).sort()).toEqual(['initial', 'renewal'])
  })
})
