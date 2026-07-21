import 'reflect-metadata'

import { Result, UniqueEntityId, Username } from '@standardnotes/domain-core'

import { TypeORMRevenueModification } from '../../Infra/TypeORM/TypeORMRevenueModification'
import { MonthlyRevenue } from '../Revenue/MonthlyRevenue'
import { RevenueModification } from '../Revenue/RevenueModification'
import { Subscription } from '../Subscription/Subscription'
import { SubscriptionEventType } from '../Subscription/SubscriptionEventType'
import { SubscriptionPlanName } from '../Subscription/SubscriptionPlanName'
import { User } from '../User/User'

import { RevenueModificationMap } from './RevenueModificationMap'

describe('RevenueModificationMap', () => {
  const uuid = '84c0f8e8-544a-4c7e-9adf-26209303bc1d'
  const userUuid = '2e1e43b0-3a2e-4e1c-8a92-5b4e5f6a7b8c'

  const createMap = () => new RevenueModificationMap()

  const createPersistence = (overrides: Partial<TypeORMRevenueModification> = {}) =>
    ({
      uuid,
      userUuid,
      username: 'test@test.te',
      subscriptionId: 5,
      subscriptionPlan: 'PLUS_PLAN',
      eventType: 'SUBSCRIPTION_PURCHASED',
      billingFrequency: 12,
      isNewCustomer: true,
      previousMonthlyRevenue: 0,
      newMonthlyRevenue: 1.5,
      createdAt: 1_672_628_645,
      ...overrides,
    }) as TypeORMRevenueModification

  describe('toDomain', () => {
    it('rebuilds the aggregate with its persisted identifiers', () => {
      const domain = createMap().toDomain(createPersistence())

      expect(domain.id.toString()).toEqual(uuid)
      expect(domain.props.user.id.toString()).toEqual(userUuid)
      expect(domain.props.user.props.username.value).toEqual('test@test.te')
      expect(domain.props.subscription.id.toValue()).toEqual(5)
      expect(domain.props.eventType.value).toEqual('SUBSCRIPTION_PURCHASED')
      expect(domain.props.createdAt).toEqual(1_672_628_645)
    })

    it('recovers the paid amount as the billing frequency times the new monthly revenue', () => {
      const domain = createMap().toDomain(createPersistence({ billingFrequency: 12, newMonthlyRevenue: 1.5 }))

      expect(domain.props.subscription.props.payedAmount).toEqual(18)
      expect(domain.props.subscription.props.billingFrequency).toEqual(12)
      expect(domain.props.subscription.props.isFirstSubscriptionForUser).toEqual(true)
      expect(domain.props.subscription.props.planName.value).toEqual('PLUS_PLAN')
    })

    it('carries both monthly revenue figures across', () => {
      const domain = createMap().toDomain(createPersistence({ previousMonthlyRevenue: 4, newMonthlyRevenue: 9 }))

      expect(domain.props.previousMonthlyRevenue.value).toEqual(4)
      expect(domain.props.newMonthlyRevenue.value).toEqual(9)
    })

    it('refuses to map a row whose subscription plan is not recognised', () => {
      expect(() => createMap().toDomain(createPersistence({ subscriptionPlan: 'GOLD_PLAN' }))).toThrow(
        'Invalid subscription plan name GOLD_PLAN',
      )
    })

    it('refuses to map a row whose event type is not recognised', () => {
      expect(() => createMap().toDomain(createPersistence({ eventType: 'SUBSCRIPTION_PAUSED' }))).toThrow(
        'Invalid subscription event type SUBSCRIPTION_PAUSED',
      )
    })

    it('reports which part of the aggregate could not be built', () => {
      jest.spyOn(User, 'create').mockReturnValueOnce(Result.fail('bad user'))
      expect(() => createMap().toDomain(createPersistence())).toThrow('Could not create user: bad user')

      jest.spyOn(Subscription, 'create').mockReturnValueOnce(Result.fail('bad subscription'))
      expect(() => createMap().toDomain(createPersistence())).toThrow('Could not create subscription: bad subscription')

      jest.spyOn(RevenueModification, 'create').mockReturnValueOnce(Result.fail('bad modification'))
      expect(() => createMap().toDomain(createPersistence())).toThrow(
        'Could not map revenue modification to domain: bad modification',
      )
    })
  })

  describe('toProjection', () => {
    it('flattens the aggregate onto the persistence columns', () => {
      const user = User.create(
        { username: Username.create('test@test.te').getValue() },
        new UniqueEntityId(userUuid),
      ).getValue()
      const subscription = Subscription.create(
        {
          billingFrequency: 12,
          isFirstSubscriptionForUser: false,
          payedAmount: 18,
          planName: SubscriptionPlanName.create('PRO_PLAN').getValue(),
        },
        new UniqueEntityId(5),
      ).getValue()
      const domain = RevenueModification.create(
        {
          user,
          subscription,
          eventType: SubscriptionEventType.create('SUBSCRIPTION_RENEWED').getValue(),
          previousMonthlyRevenue: MonthlyRevenue.create(1).getValue(),
          newMonthlyRevenue: MonthlyRevenue.create(1.5).getValue(),
          createdAt: 1_672_628_645,
        },
        new UniqueEntityId(uuid),
      ).getValue()

      const persistence = createMap().toProjection(domain)

      expect(persistence).toBeInstanceOf(TypeORMRevenueModification)
      expect(persistence.uuid).toEqual(uuid)
      expect(persistence.userUuid).toEqual(userUuid)
      expect(persistence.username).toEqual('test@test.te')
      expect(persistence.subscriptionId).toEqual(5)
      expect(persistence.subscriptionPlan).toEqual('PRO_PLAN')
      expect(persistence.eventType).toEqual('SUBSCRIPTION_RENEWED')
      expect(persistence.billingFrequency).toEqual(12)
      expect(persistence.isNewCustomer).toEqual(false)
      expect(persistence.previousMonthlyRevenue).toEqual(1)
      expect(persistence.newMonthlyRevenue).toEqual(1.5)
      expect(persistence.createdAt).toEqual(1_672_628_645)
    })
  })

  it('round-trips a row back to an identical projection', () => {
    const map = createMap()
    const persistence = createPersistence()

    expect(map.toProjection(map.toDomain(persistence))).toEqual(persistence)
  })
})
