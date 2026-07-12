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
       * PERSIST-M1: checkpoint the stored version as migrations complete, so an interrupted
       * run resumes from where it left off instead of re-running everything from scratch.
       *
       * The subtlety that makes a naive per-migration stamp WRONG: migrations complete in
       * STAGE order, not version order (a higher-version migration can register on an earlier
       * stage than a lower-version one — e.g. 2.168.6 runs at Launched_10, 2.0.15 at the later
       * LoadedDatabase_12). getRequiredMigrations selects purely by `version > stored`, so
       * stamping each migration's own version as it finishes breaks BOTH ways:
       *   - it can regress (2.168.6 -> 2.0.15), re-running already-completed higher migrations;
       *   - a plain max() guard would instead lock the stamp forward at 2.168.6 after the
       *     earliest stage, permanently SKIPPING the still-pending lower-version migrations
       *     (2.0.15 creates the default items key — a data-integrity hazard).
       *
       * Fix: advance the stamp only to the top of the CONTIGUOUS completed prefix (by version).
       * `activeMigrations` is version-ascending (getRequiredMigrations sorts ascending and
       * assertMigrationsAreWellRegistered enforces it), so we stamp version V only once every
       * active migration with version <= V is done — never regressing and never skipping a
       * pending migration. The cost is that an out-of-order-completed HIGHER migration may
       * harmlessly re-run after a crash, which is the safe, idempotent direction.
       */
      const migrations = this.activeMigrations
      const completed = new Array<boolean>(migrations.length).fill(false)
      let highestStampedVersion: string | undefined

      migrations.forEach((migration, index) => {
        migration.onDone(async () => {
          completed[index] = true

          let prefixLength = 0
          while (prefixLength < completed.length && completed[prefixLength]) {
            prefixLength++
          }

          if (prefixLength === 0) {
            return
          }

          /**
           * When the whole set is done we stamp the full current SnjsVersion (not just the
           * top migration's version) so the app is marked fully up to date even when the
           * last migration's version is lower than the running SnjsVersion.
           */
          const allDone = prefixLength === migrations.length
          const versionToStamp = allDone
            ? SnjsVersion
            : (migrations[prefixLength - 1].constructor as typeof Migration).version()

          // Defensive never-regress guard; also skips redundant identical re-writes when an
          // out-of-order completion did not extend the contiguous prefix.
          if (
            highestStampedVersion !== undefined &&
            !isRightVersionGreaterThanLeft(highestStampedVersion, versionToStamp)
          ) {
            return
          }

          highestStampedVersion = versionToStamp
          await this.stampStoredVersion(versionToStamp)
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
