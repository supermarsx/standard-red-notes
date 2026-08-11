import { FeatureStatus } from '@standardnotes/snjs'
import { FeaturesController } from './FeaturesController'

jest.mock('@/FeatureTrunk', () => ({
  featureTrunkVaultsEnabled: () => false,
}))

type VaultRoleScenario = {
  role: string
  featureStatus: FeatureStatus
  isAdmin: boolean
  expected: boolean
}

const createController = (scenario: Omit<VaultRoleScenario, 'role' | 'expected'>) => {
  const features = {
    isExperimentalFeatureEnabled: jest.fn().mockReturnValue(false),
    getFeatureStatus: jest.fn().mockReturnValue(scenario.featureStatus),
    hasRole: jest.fn().mockReturnValue(scenario.isAdmin),
  }
  const eventBus = {
    addEventHandler: jest.fn(),
  }

  return new FeaturesController(features as never, eventBus as never)
}

describe('FeaturesController vault capability gating', () => {
  it.each<VaultRoleScenario>([
    {
      role: 'Full user',
      featureStatus: FeatureStatus.Entitled,
      isAdmin: false,
      expected: true,
    },
    {
      role: 'Vaults user',
      featureStatus: FeatureStatus.Entitled,
      isAdmin: false,
      expected: true,
    },
    {
      role: 'Admin user',
      featureStatus: FeatureStatus.NotInCurrentPlan,
      isAdmin: true,
      expected: true,
    },
    {
      role: 'Core user without the shared-vault entitlement',
      featureStatus: FeatureStatus.NotInCurrentPlan,
      isAdmin: false,
      expected: false,
    },
  ])('reports Vaults enabled for $role: $expected', ({ featureStatus, isAdmin, expected }) => {
    const controller = createController({ featureStatus, isAdmin })

    expect(controller.isVaultsEnabled()).toBe(expected)
  })
})
