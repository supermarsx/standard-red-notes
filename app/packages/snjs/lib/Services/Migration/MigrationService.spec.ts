import { ApplicationStage } from '@standardnotes/services'
import { Migration } from '@Lib/Migrations/Migration'
import { MigrationService } from './MigrationService'
import { SnjsVersion, isRightVersionGreaterThanLeft } from '../../Version'

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

/**
 * These three mirror the REAL stage/version inversion in the shipped migration set: a HIGH
 * version migration (2.168.6) runs at the EARLIEST stage (Launched_10), while a LOWER version
 * migration (2.0.15 — which in production creates the default items encryption key) runs at a
 * LATER stage (LoadedDatabase_12). MigrationTop (2.209.0) is the genuine highest version and
 * runs last. Sorted ascending by version the active set is [Low, High, Top].
 */
class MigrationLow extends Migration {
  static override version(): string {
    return '2.0.15'
  }
  protected registerStageHandlers(): void {
    this.registerStageHandler(ApplicationStage.LoadedDatabase_12, async () => {
      this.markDone()
    })
  }
}

class MigrationHigh extends Migration {
  static override version(): string {
    return '2.168.6'
  }
  protected registerStageHandlers(): void {
    this.registerStageHandler(ApplicationStage.Launched_10, async () => {
      this.markDone()
    })
  }
}

class MigrationTop extends Migration {
  static override version(): string {
    return '2.209.0'
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
    ;(svc as any).instantiateMigrationClasses = (classes: any[]) => classes.map((klass) => new klass(services))

    return svc
  }

  beforeEach(() => {
    jest.clearAllMocks()
    storedVersion = '1.0.0'
  })

  it('checkpoints the stored version after EACH migration completes (PERSIST-M1)', async () => {
    jest.spyOn(MigrationService as any, 'getRequiredMigrations').mockReturnValue([MigrationA, MigrationB])

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

  it('never stamps a REGRESSING version when migrations complete out of stage/version order (PERSIST-M1)', async () => {
    // Active set (version-ascending): Low(2.0.15), High(2.168.6), Top(2.209.0).
    jest
      .spyOn(MigrationService as any, 'getRequiredMigrations')
      .mockImplementation((stored: string) =>
        [MigrationLow, MigrationHigh, MigrationTop].filter((m) => isRightVersionGreaterThanLeft(stored, m.version())),
      )

    service = createService()
    await service.initialize()

    const migrations = (service as any).activeMigrations as Migration[]

    // Drive the REAL stage order: Launched_10 (High) -> LoadedDatabase_12 (Low) ->
    // FullSyncCompleted_13 (Top). High (2.168.6) therefore completes BEFORE Low (2.0.15).
    for (const stage of [
      ApplicationStage.Launched_10,
      ApplicationStage.LoadedDatabase_12,
      ApplicationStage.FullSyncCompleted_13,
    ]) {
      for (const migration of migrations) {
        await migration.handleStage(stage)
      }
    }

    const stamped = setRawStorageValue.mock.calls.map((call) => call[1] as string)

    // The stored version must be monotonically non-decreasing across every write — the old
    // per-own-version stamping produced 2.168.6 -> 2.0.15 (a regression) here.
    for (let i = 1; i < stamped.length; i++) {
      expect(isRightVersionGreaterThanLeft(stamped[i], stamped[i - 1])).toBe(false)
    }
    // And the run ends fully up to date.
    expect(stamped[stamped.length - 1]).toBe(SnjsVersion)
  })

  it('does NOT skip a lower-version, later-stage migration after a crash between stages (PERSIST-M1)', async () => {
    // Active set (version-ascending): Low(2.0.15), High(2.168.6), Top(2.209.0).
    jest
      .spyOn(MigrationService as any, 'getRequiredMigrations')
      .mockImplementation((stored: string) =>
        [MigrationLow, MigrationHigh, MigrationTop].filter((m) => isRightVersionGreaterThanLeft(stored, m.version())),
      )

    service = createService()
    await service.initialize()

    const migrations = (service as any).activeMigrations as Migration[]

    // Simulate a crash right after the FIRST stage: only Launched_10 fires, so High (2.168.6)
    // completes but Low (2.0.15, later stage) and Top do not.
    for (const migration of migrations) {
      await migration.handleStage(ApplicationStage.Launched_10)
    }

    // The stored stamp must NOT have advanced past the still-pending lower-version migration,
    // otherwise getRequiredMigrations would permanently skip it on the next launch. (Low in
    // production is Migration2_0_15, which creates the default items encryption key.)
    // Old behavior stamped 2.168.6 here -> Low would be dropped.
    expect(isRightVersionGreaterThanLeft(storedVersion, MigrationLow.version())).toBe(true)

    // Concretely: a relaunch still selects Low, High, and Top (High re-runs — the safe,
    // idempotent direction — but nothing is skipped).
    const resumed = (MigrationService as any).getRequiredMigrations(storedVersion) as (typeof Migration)[]
    expect(resumed.map((m) => m.version())).toEqual(['2.0.15', '2.168.6', '2.209.0'])
  })

  it('marks migrations as done immediately when none are required', async () => {
    jest.spyOn(MigrationService as any, 'getRequiredMigrations').mockReturnValue([])

    service = createService()
    await service.initialize()

    expect(setRawStorageValue).toHaveBeenCalledWith(expect.stringContaining(SNJS_KEY), SnjsVersion)
  })
})
