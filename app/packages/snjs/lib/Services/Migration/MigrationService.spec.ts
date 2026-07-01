import { ApplicationStage } from '@standardnotes/services'
import { Migration } from '@Lib/Migrations/Migration'
import { MigrationService } from './MigrationService'
import { SnjsVersion } from '../../Version'

/**
 * Two simple fake migrations whose only stage handler marks them done. They let us
 * exercise the per-migration checkpoint (PERSIST-M1) without standing up the full
 * migration stack.
 */
class MigrationA extends Migration {
  static override version(): string {
    return '2.0.0'
  }
  protected registerStageHandlers(): void {
    this.registerStageHandler(ApplicationStage.FullSyncCompleted_13, async () => {
      this.markDone()
    })
  }
}

class MigrationB extends Migration {
  static override version(): string {
    return '2.5.0'
  }
  protected registerStageHandlers(): void {
    this.registerStageHandler(ApplicationStage.FullSyncCompleted_13, async () => {
      this.markDone()
    })
  }
}

describe('MigrationService', () => {
  let setRawStorageValue: jest.Mock
  let storedVersion: string
  let services: any
  let service: MigrationService

  const SNJS_KEY = 'snjs_version'

  const createService = () => {
    setRawStorageValue = jest.fn((_key: string, value: string) => {
      // Persisting the stamped version is exactly what makes resumption work.
      storedVersion = value
      return Promise.resolve()
    })

    services = {
      internalEventBus: { addEventHandler: jest.fn() },
      identifier: 'app',
      deviceInterface: {
        setRawStorageValue,
        getRawStorageValue: jest.fn(),
      },
    }

    const svc = new MigrationService(services)

    // Avoid running the real base migration / device wiring.
    ;(svc as any).runBaseMigrationPreRun = jest.fn().mockResolvedValue(undefined)
    ;(svc as any).getStoredSnjsVersion = jest.fn().mockImplementation(() => Promise.resolve(storedVersion))
    // Build fake instances directly from the (already filtered) required classes.
    ;(svc as any).instantiateMigrationClasses = (classes: any[]) =>
      classes.map((klass) => new klass(services))

    return svc
  }

  beforeEach(() => {
    jest.clearAllMocks()
    storedVersion = '1.0.0'
  })

  it('checkpoints the stored version after EACH migration completes (PERSIST-M1)', async () => {
    jest
      .spyOn(MigrationService as any, 'getRequiredMigrations')
      .mockReturnValue([MigrationA, MigrationB])

    service = createService()
    await service.initialize()

    // Drive each migration to completion via the stage they listen on. We call the
    // individual migrations' handleStage (rather than the service's, which also touches
    // the base migration) to keep the test focused on the checkpoint behavior.
    const migrations = (service as any).activeMigrations as Migration[]
    for (const migration of migrations) {
      await migration.handleStage(ApplicationStage.FullSyncCompleted_13)
    }

    const stampedVersions = setRawStorageValue.mock.calls.map((call) => call[1])

    // First completion stamps MigrationA's version, then the last stamps the full SnjsVersion.
    expect(stampedVersions).toEqual(['2.0.0', SnjsVersion])
  })

  it('resumes from the last completed migration after an interrupted run (PERSIST-M1)', async () => {
    // === First launch: only MigrationA completes, then we "crash". ===
    const getRequired = jest.spyOn(MigrationService as any, 'getRequiredMigrations')

    // Simulate getRequiredMigrations honoring the stored version: with storedVersion 1.0.0,
    // both migrations are required.
    getRequired.mockImplementation((stored: string) => {
      const all = [MigrationA, MigrationB]
      return all.filter((m) => m.version() > stored)
    })

    service = createService()
    await service.initialize()

    const firstMigration = (service as any).activeMigrations[0] as Migration
    // Only run MigrationA's onDone (simulate crash before MigrationB).
    ;(firstMigration as any).markDone()
    await Promise.resolve()

    expect(storedVersion).toBe('2.0.0')

    // === Second launch: stored version is now 2.0.0, so MigrationA must be skipped. ===
    service = createService()
    await service.initialize()

    const resumedMigrations = (service as any).activeMigrations as Migration[]
    const resumedVersions = resumedMigrations.map((m) => (m.constructor as typeof Migration).version())

    // MigrationA (2.0.0) already done -> not re-run. Only MigrationB (2.5.0) remains.
    expect(resumedVersions).toEqual(['2.5.0'])
  })

  it('marks migrations as done immediately when none are required', async () => {
    jest.spyOn(MigrationService as any, 'getRequiredMigrations').mockReturnValue([])

    service = createService()
    await service.initialize()

    expect(setRawStorageValue).toHaveBeenCalledWith(expect.stringContaining(SNJS_KEY), SnjsVersion)
  })
})
