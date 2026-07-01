import { BaseMigration } from '@Lib/Migrations/Base'
import { compareSemVersions } from '@Lib/Version'
import { Migration } from '@Lib/Migrations/Migration'
import { MigrationServices } from '../../Migrations/MigrationServices'
import {
  RawStorageKey,
  namespacedKey,
  ApplicationEvent,
  ApplicationStage,
  AbstractService,
  DiagnosticInfo,
  InternalEventHandlerInterface,
  InternalEventInterface,
  ApplicationStageChangedEventPayload,
} from '@standardnotes/services'
import { SnjsVersion, isRightVersionGreaterThanLeft } from '../../Version'
import { SNLog } from '@Lib/Log'
import { MigrationClasses } from '@Lib/Migrations/Versions'

/**
 * The migration service orchestrates the execution of multi-stage migrations.
 * Migrations are registered during initial application launch, and listen for application
 * life-cycle events, and act accordingly. Migrations operate on the app-level, and not global level.
 * For example, a single migration may perform a unique set of steps when the application
 * first launches, and also other steps after the application is unlocked, or after the
 * first sync completes. Migrations live under /migrations and inherit from the base Migration class.
 */
export class MigrationService extends AbstractService implements InternalEventHandlerInterface {
  private activeMigrations?: Migration[]
  private baseMigration!: BaseMigration

  constructor(private services: MigrationServices) {
    super(services.internalEventBus)
  }

  override deinit(): void {
    ;(this.services as unknown) = undefined

    if (this.activeMigrations) {
      this.activeMigrations.length = 0
    }

    super.deinit()
  }

  public async initialize(): Promise<void> {
    MigrationService.assertMigrationsAreWellRegistered()

    await this.runBaseMigrationPreRun()

    const requiredMigrations = MigrationService.getRequiredMigrations(await this.getStoredSnjsVersion())

    this.activeMigrations = this.instantiateMigrationClasses(requiredMigrations)

    if (this.activeMigrations.length > 0) {
      /**
       * PERSIST-M1: checkpoint the stored version PER migration. Previously the stored
       * SnjsVersion was only stamped on the LAST migration's onDone, so a crash mid-run
       * re-ran ALL migrations on next launch (and additive merges like 2_202_1 could
       * re-clobber user edits). We now stamp the stored version after EACH migration
       * completes, so an interrupted run resumes from the last completed migration.
       *
       * getRequiredMigrations skips any migration whose version is <= the stored
       * version, so these per-migration stamps are what make resumption idempotent.
       */
      this.activeMigrations.forEach((migration, index) => {
        const isLast = index === this.activeMigrations!.length - 1
        const migrationConstructor = migration.constructor as typeof Migration
        const checkpointVersion = migrationConstructor.version()

        migration.onDone(async () => {
          /**
           * For the last migration we stamp the full current SnjsVersion (not just the
           * migration's own version) so the app is marked fully up to date even when the
           * last migration's version is lower than the running SnjsVersion.
           */
          await this.stampStoredVersion(isLast ? SnjsVersion : checkpointVersion)
        })
      })
    } else {
      await this.markMigrationsAsDone()
    }
  }

  private async markMigrationsAsDone() {
    await this.stampStoredVersion(SnjsVersion)
  }

  private async stampStoredVersion(version: string) {
    await this.services.deviceInterface.setRawStorageValue(
      namespacedKey(this.services.identifier, RawStorageKey.SnjsVersion),
      version,
    )
  }

  /**
   * PERSIST-M2: the registered migrations array (Migrations/Versions/index.ts) is a
   * hand-maintained ordered import list with no glob, so a forgotten registration would
   * silently skip a migration. This cheap safeguard asserts the registered array is
   * sorted strictly ascending by version (and contains no duplicates), throwing loudly
   * if not. We don't change the import mechanism — just guard it.
   */
  private static assertMigrationsAreWellRegistered(): void {
    for (let i = 1; i < MigrationClasses.length; i++) {
      const previous = MigrationClasses[i - 1].version()
      const current = MigrationClasses[i].version()
      const comparison = compareSemVersions(previous, current)

      if (comparison === 0) {
        throw SNLog.error(Error(`Migration registration error: duplicate migration version ${current}.`))
      }

      if (comparison === 1) {
        throw SNLog.error(
          Error(
            `Migration registration error: migrations are not sorted ascending by version ` +
              `(${previous} is registered before ${current}). Check Migrations/Versions/index.ts.`,
          ),
        )
      }
    }
  }

  private async runBaseMigrationPreRun() {
    this.baseMigration = new BaseMigration(this.services)
    await this.baseMigration.preRun()
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.ApplicationStageChanged) {
      const stage = (event.payload as ApplicationStageChangedEventPayload).stage
      await this.handleStage(stage)
    }
  }

  /**
   * Called by application
   */
  public async handleApplicationEvent(event: ApplicationEvent): Promise<void> {
    if (event === ApplicationEvent.SignedIn) {
      await this.handleStage(ApplicationStage.SignedIn_30)
    }
  }

  public async hasPendingMigrations(): Promise<boolean> {
    const requiredMigrations = MigrationService.getRequiredMigrations(await this.getStoredSnjsVersion())
    return requiredMigrations.length > 0 || (await this.baseMigration.needsKeychainRepair())
  }

  public async getStoredSnjsVersion(): Promise<string> {
    const version = await this.services.deviceInterface.getRawStorageValue(
      namespacedKey(this.services.identifier, RawStorageKey.SnjsVersion),
    )
    if (!version) {
      throw SNLog.error(Error('Snjs version missing from storage, run base migration.'))
    }
    return version
  }

  private static getRequiredMigrations(storedVersion: string) {
    const resultingClasses = []
    const sortedClasses = MigrationClasses.sort((a, b) => {
      return compareSemVersions(a.version(), b.version())
    })
    for (const migrationClass of sortedClasses) {
      const migrationVersion = migrationClass.version()
      if (migrationVersion === storedVersion) {
        continue
      }
      if (isRightVersionGreaterThanLeft(storedVersion, migrationVersion)) {
        resultingClasses.push(migrationClass)
      }
    }
    return resultingClasses
  }

  private instantiateMigrationClasses(classes: typeof MigrationClasses): Migration[] {
    return classes.map((migrationClass) => {
      return new migrationClass(this.services)
    })
  }

  private async handleStage(stage: ApplicationStage) {
    await this.baseMigration.handleStage(stage)

    if (!this.activeMigrations) {
      throw new Error('Invalid active migrations')
    }

    for (const migration of this.activeMigrations) {
      await migration.handleStage(stage)
    }
  }

  override getDiagnostics(): Promise<DiagnosticInfo | undefined> {
    return Promise.resolve({
      migrations: {
        activeMigrations: this.activeMigrations && this.activeMigrations.map((m) => typeof m),
      },
    })
  }
}
