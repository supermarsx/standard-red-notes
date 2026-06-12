import { NativeFeatureIdentifier } from '@standardnotes/features'
import { FeatureStatus, ItemManagerInterface } from '@standardnotes/services'
import { GetFeatureStatusUseCase } from './GetFeatureStatus'
import { ComponentInterface } from '@standardnotes/models'
import { Uuid } from '@standardnotes/domain-core'

describe('GetFeatureStatusUseCase', () => {
  let items: jest.Mocked<ItemManagerInterface>
  let usecase: GetFeatureStatusUseCase
  let findNativeFeature: jest.Mock<any, any>

  beforeEach(() => {
    items = {
      getDisplayableComponents: jest.fn(),
    } as unknown as jest.Mocked<ItemManagerInterface>
    usecase = new GetFeatureStatusUseCase(items)
    findNativeFeature = jest.fn()
    usecase.findNativeFeature = findNativeFeature
    findNativeFeature.mockReturnValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('native features', () => {
    it('should always return Entitled for native features regardless of subscription or roles', () => {
      findNativeFeature.mockReturnValue({ deprecated: false })

      expect(
        usecase.execute({
          featureId: NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.AutobiographyTheme).getValue(),
          firstPartyOnlineSubscription: undefined,
          firstPartyRoles: undefined,
          hasPaidAnyPartyOnlineOrOfflineSubscription: false,
        }),
      ).toEqual(FeatureStatus.Entitled)
    })

    it('should return Entitled for deprecated native features regardless of subscription', () => {
      findNativeFeature.mockReturnValue({ deprecated: true })

      expect(
        usecase.execute({
          featureId: NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.AutobiographyTheme).getValue(),
          firstPartyOnlineSubscription: undefined,
          firstPartyRoles: undefined,
          hasPaidAnyPartyOnlineOrOfflineSubscription: false,
        }),
      ).toEqual(FeatureStatus.Entitled)
    })
  })

  describe('third party features', () => {
    it('should return Entitled for third-party features', () => {
      const mockComponent = {
        uuid: '00000000-0000-0000-0000-000000000000',
        isExpired: false,
      } as unknown as jest.Mocked<ComponentInterface>

      items.getDisplayableComponents.mockReturnValue([mockComponent])

      expect(
        usecase.execute({
          featureId: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
          hasPaidAnyPartyOnlineOrOfflineSubscription: false,
          firstPartyOnlineSubscription: undefined,
          firstPartyRoles: undefined,
        }),
      ).toEqual(FeatureStatus.Entitled)
    })

    it('should return Entitled for non-existing third-party features', () => {
      ;(items.getDisplayableComponents as jest.Mock).mockReturnValue([])

      expect(
        usecase.execute({
          featureId: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
          hasPaidAnyPartyOnlineOrOfflineSubscription: false,
          firstPartyOnlineSubscription: undefined,
          firstPartyRoles: undefined,
        }),
      ).toEqual(FeatureStatus.Entitled)
    })

    it('should return Entitled for expired third-party features', () => {
      const mockComponent = {
        uuid: '00000000-0000-0000-0000-000000000000',
        isExpired: true,
      } as unknown as jest.Mocked<ComponentInterface>

      items.getDisplayableComponents.mockReturnValue([mockComponent])

      expect(
        usecase.execute({
          featureId: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
          hasPaidAnyPartyOnlineOrOfflineSubscription: false,
          firstPartyOnlineSubscription: undefined,
          firstPartyRoles: undefined,
        }),
      ).toEqual(FeatureStatus.Entitled)
    })
  })
})
