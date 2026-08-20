export const MAX_FOLDER_PATH_DEPTH = 64

export type NormalizedFolderName = {
  display: string
  identity: string
}

export function normalizeFolderName(value: string): NormalizedFolderName | undefined {
  const display = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!display) {
    return undefined
  }

  return {
    display,
    identity: display.toLocaleLowerCase('en-US'),
  }
}

export function folderCreationScope(accountUuid: string | undefined, vaultUuid: string | undefined): string {
  return JSON.stringify([accountUuid || 'local-account', vaultUuid || 'default-vault'])
}

export function folderCreationIdentity(parentPath: readonly string[], title: string): string {
  if (parentPath.length >= MAX_FOLDER_PATH_DEPTH) {
    throw new Error(`Folder paths cannot exceed ${MAX_FOLDER_PATH_DEPTH} levels.`)
  }

  const normalizedTitle = normalizeFolderName(title)
  if (!normalizedTitle) {
    throw new Error('Folder names cannot be empty.')
  }

  const normalizedParentPath = parentPath.map((segment) => {
    const normalized = normalizeFolderName(segment)
    if (!normalized) {
      throw new Error('Folder paths cannot contain an empty segment.')
    }
    return normalized.identity
  })

  return JSON.stringify([...normalizedParentPath, normalizedTitle.identity])
}

/**
 * How many times one folder identity may be physically inserted within a single scope generation.
 * Deleting a folder and recreating it by the same name is legitimate and must keep working, so this
 * is a ceiling on runaway repetition rather than a strict once-only rule. Releasing the scope (an
 * account or vault change) resets it.
 */
export const MAX_INSERTS_PER_FOLDER_IDENTITY = 3

export type FolderCreationFinalizationOutcome = 'ambiguous' | 'definitive'

/** Serializes the one-time legacy migration per shared ItemManager owner. */
export class FolderMigrationCoordinator<Owner extends object> {
  private readonly activeOwners = new WeakSet<Owner>()

  public async run(owner: Owner, migrate: () => Promise<void>): Promise<boolean> {
    if (this.activeOwners.has(owner)) {
      return false
    }
    this.activeOwners.add(owner)
    try {
      await migrate()
      return true
    } finally {
      // Failure is intentionally retryable. A permanent WeakSet entry here would
      // strand this ItemManager until a full page reload.
      this.activeOwners.delete(owner)
    }
  }
}

/**
 * Marks whether a failed post-insert step may already have reached the server.
 * Both outcomes retain the inserted item and operation ID. An ambiguous retry
 * first resolves local status; a definitive retry re-runs finalization directly.
 */
export class FolderCreationFinalizationError extends Error {
  override readonly name = 'FolderCreationFinalizationError'

  constructor(
    readonly outcome: FolderCreationFinalizationOutcome,
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message)
  }
}

type CreateOnceOptions<Item> = {
  scope: string
  identity: string
  /** Opaque, per-user-action UUID. Duplicate submissions keep the first value. */
  operationId: string
  findExisting(): Item | undefined
  /** Lets a completed entry expire after the item was explicitly removed. */
  isCurrent?(item: Item): boolean
  create(operationId: string): Promise<Item>
  finalize(item: Item, operationId: string): Promise<void>
  /** Returns true when an ambiguous response was later observed as durable. */
  resolveAmbiguous?(item: Item, operationId: string, error: unknown): boolean | Promise<boolean>
  classifyFinalizeError?(error: unknown): FolderCreationFinalizationOutcome
}

type CreationEntry<Item> = {
  item: Item
  operationId: string
  state: 'pending' | 'finalized' | FolderCreationFinalizationOutcome
  lastError?: unknown
}

/**
 * Coalesces every physical folder insert for one account/vault/path identity.
 *
 * The promise is installed before `create` runs, so a synchronous item observer
 * cannot start a second insert. A post-insert failure retains both the item and
 * operation ID; a later explicit retry re-runs or resolves finalization against
 * that same UUID instead of manufacturing another item.
 */
export class FolderCreationCoordinator<Item> {
  private readonly inFlight = new Map<string, Promise<Item>>()
  private readonly entries = new Map<string, CreationEntry<Item>>()
  private readonly successfulInsertCounts = new Map<string, number>()
  /**
   * Inserts performed for this identity since the scope was last released, INCLUDING those whose
   * entry was later dropped because `isCurrent` reported the item gone.
   *
   * `successfulInsertCounts` alone cannot bound anything: the "item was explicitly removed" branch
   * deletes it, and that branch fires whenever the created folder is absent from local item state
   * for ANY reason. If local application of items is broken, every attempt looks like a fresh
   * user action and inserts again — an unbounded write storm producing duplicate folders. This
   * counter is deliberately independent of local item state and survives that branch.
   */
  private readonly lifetimeInsertCounts = new Map<string, number>()
  private readonly scopeGenerations = new Map<string, number>()
  /** Monotonic process-local epoch; it contains no account/vault identifiers. */
  private nextScopeGeneration = 0

  public createOnce(options: CreateOnceOptions<Item>): Promise<Item> {
    this.assertOperationId(options.operationId)
    const generation = this.getOrCreateScopeGeneration(options.scope)
    const key = this.key(options.scope, generation, options.identity)

    const active = this.inFlight.get(key)
    if (active) {
      return active
    }

    const entry = this.entries.get(key)
    if (entry) {
      if (entry.state !== 'finalized') {
        return this.startOperation(key, options.scope, generation, () => this.finalizeEntry(entry, options))
      }

      const liveExisting = options.findExisting()
      if (liveExisting) {
        entry.item = liveExisting
        return Promise.resolve(liveExisting)
      }
      if (!options.isCurrent || options.isCurrent(entry.item)) {
        return Promise.resolve(entry.item)
      }

      // The previously completed item appears to be gone, which is normally an explicit removal:
      // a new user action whose new operation ID may legitimately create it again. The lifetime
      // counter is intentionally NOT cleared here, so a broken local store cannot make this look
      // like an endless series of fresh user actions.
      this.entries.delete(key)
      this.successfulInsertCounts.delete(key)
    }

    const existing = options.findExisting()
    if (existing) {
      this.entries.set(key, {
        item: existing,
        operationId: options.operationId,
        state: 'finalized',
      })
      return Promise.resolve(existing)
    }

    const blocked = this.insertRefusalReason(key)
    if (blocked) {
      return Promise.reject(new Error(blocked))
    }

    return this.startOperation(key, options.scope, generation, async () => {
      const reloadedExisting = options.findExisting()
      if (reloadedExisting) {
        this.entries.set(key, {
          item: reloadedExisting,
          operationId: options.operationId,
          state: 'finalized',
        })
        return reloadedExisting
      }

      const blockedOnEntry = this.insertRefusalReason(key)
      if (blockedOnEntry) {
        throw new Error(blockedOnEntry)
      }

      const created = await options.create(options.operationId)
      const createdEntry: CreationEntry<Item> = {
        item: created,
        operationId: options.operationId,
        state: 'pending',
      }
      this.successfulInsertCounts.set(key, 1)
      this.lifetimeInsertCounts.set(key, (this.lifetimeInsertCounts.get(key) ?? 0) + 1)
      this.entries.set(key, createdEntry)
      return this.finalizeEntry(createdEntry, options)
    })
  }

  private insertRefusalReason(key: string): string | undefined {
    if ((this.successfulInsertCounts.get(key) ?? 0) >= 1) {
      return 'Folder creation circuit breaker stopped a duplicate insert.'
    }
    if ((this.lifetimeInsertCounts.get(key) ?? 0) >= MAX_INSERTS_PER_FOLDER_IDENTITY) {
      return (
        `Folder creation stopped after ${MAX_INSERTS_PER_FOLDER_IDENTITY} inserts of the same folder. ` +
        'The created folder is not present in local item state, so creating it again would only ' +
        'duplicate it on the server.'
      )
    }
    return undefined
  }

  /**
   * Advances the scope generation immediately. Pending callers still settle,
   * while a new controller/action cannot attach to their stale promise. Settled
   * state is deleted now; pending state is deleted by startOperation's finally.
   */
  public releaseScope(scope: string): void {
    this.scopeGenerations.set(scope, this.createScopeGeneration())
    const prefix = `${scope}\u0000`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && !this.inFlight.has(key)) {
        this.entries.delete(key)
        this.successfulInsertCounts.delete(key)
      }
    }
    for (const key of [...this.lifetimeInsertCounts.keys()]) {
      if (key.startsWith(prefix) && !this.inFlight.has(key)) {
        this.lifetimeInsertCounts.delete(key)
      }
    }
    this.retireScopeIfUnused(scope)
  }

  public releaseAllSettled(): void {
    for (const scope of [...this.scopeGenerations.keys()]) {
      this.releaseScope(scope)
    }
  }

  /** Test/diagnostic seams: expose counts only, never scope values or item IDs. */
  public retainedStateCount(): number {
    return (
      this.inFlight.size +
      this.entries.size +
      this.successfulInsertCounts.size +
      this.lifetimeInsertCounts.size +
      this.scopeGenerations.size
    )
  }

  public retainedScopeCount(): number {
    return this.scopeGenerations.size
  }

  private startOperation(key: string, scope: string, generation: number, run: () => Promise<Item>): Promise<Item> {
    const operation = Promise.resolve().then(run)
    this.inFlight.set(key, operation)
    void operation
      .finally(() => {
        if (this.inFlight.get(key) === operation) {
          this.inFlight.delete(key)
        }
        if ((this.scopeGenerations.get(scope) ?? 0) !== generation) {
          this.entries.delete(key)
          this.successfulInsertCounts.delete(key)
          this.lifetimeInsertCounts.delete(key)
        }
        this.retireScopeIfUnused(scope)
      })
      .catch(() => undefined)
    return operation
  }

  private async finalizeEntry(entry: CreationEntry<Item>, options: CreateOnceOptions<Item>): Promise<Item> {
    if (entry.state === 'ambiguous' && options.resolveAmbiguous) {
      try {
        if (await options.resolveAmbiguous(entry.item, entry.operationId, entry.lastError)) {
          entry.state = 'finalized'
          entry.lastError = undefined
          return entry.item
        }
      } catch {
        // Status could not be established. Replaying the same operation ID is
        // safer than creating a new item or claiming success.
      }
    }

    entry.state = 'pending'
    entry.lastError = undefined
    try {
      await options.finalize(entry.item, entry.operationId)
      entry.state = 'finalized'
      return entry.item
    } catch (error) {
      entry.state = options.classifyFinalizeError?.(error) ?? this.classifyFinalizeError(error)
      entry.lastError = error
      throw error
    }
  }

  private classifyFinalizeError(error: unknown): FolderCreationFinalizationOutcome {
    return error instanceof FolderCreationFinalizationError ? error.outcome : 'definitive'
  }

  private assertOperationId(operationId: string): void {
    if (!operationId || operationId.length > 128) {
      throw new Error('Folder creation operation IDs must contain 1-128 characters.')
    }
  }

  private getOrCreateScopeGeneration(scope: string): number {
    const existing = this.scopeGenerations.get(scope)
    if (existing !== undefined) {
      return existing
    }
    const generation = this.createScopeGeneration()
    this.scopeGenerations.set(scope, generation)
    return generation
  }

  private createScopeGeneration(): number {
    this.nextScopeGeneration += 1
    return this.nextScopeGeneration
  }

  private retireScopeIfUnused(scope: string): void {
    const prefix = `${scope}\u0000`
    // The lifetime counter is included deliberately: retiring the scope would mint a new generation
    // and therefore a new key, silently resetting the very guard that bounds repeated inserts.
    const hasScopedState =
      [...this.inFlight.keys()].some((key) => key.startsWith(prefix)) ||
      [...this.entries.keys()].some((key) => key.startsWith(prefix)) ||
      [...this.successfulInsertCounts.keys()].some((key) => key.startsWith(prefix)) ||
      [...this.lifetimeInsertCounts.keys()].some((key) => key.startsWith(prefix))
    if (!hasScopedState) {
      this.scopeGenerations.delete(scope)
    }
  }

  private key(scope: string, generation: number, identity: string): string {
    return `${scope}\u0000${generation}\u0000${identity}`
  }
}
