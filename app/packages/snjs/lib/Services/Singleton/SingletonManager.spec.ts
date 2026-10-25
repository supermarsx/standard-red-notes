import { ContentType } from '@standardnotes/domain-core'
import { DecryptedItemInterface, FillItemContent, Predicate } from '@standardnotes/models'
import { ItemManager } from '../Items/ItemManager'
import { PayloadManager } from '../Payloads/PayloadManager'
import { SyncService } from '../Sync/SyncService'
import { SingletonManager } from './SingletonManager'

const contentType = ContentType.TYPES.UserPrefs
type ItemObserver = (change: { inserted: DecryptedItemInterface[]; unerrored: never[] }) => void

function item(uuid: string): DecryptedItemInterface {
  return { uuid, content_type: contentType, satisfiesPredicate: () => true } as DecryptedItemInterface
}

function harness() {
  let current: DecryptedItemInterface[] = []
  const observers = new Set<ItemObserver>()
  let finishSync!: () => void
  let failSync!: (error: Error) => void
  const syncGate = new Promise<void>((resolve, reject) => {
    finishSync = resolve
    failSync = reject
  })
  const sync = {
    addEventObserver: jest.fn(() => () => undefined),
    getLastSyncDate: jest.fn(() => undefined),
    sync: jest.fn(() => syncGate),
  }
  const items = {
    addObserver: jest.fn((_type: string, observer: ItemObserver) => {
      observers.add(observer)
      return () => observers.delete(observer)
    }),
    getItems: jest.fn(() => current),
    itemsMatchingPredicate: jest.fn(() => current),
  }
  const manager = new SingletonManager(
    items as unknown as ItemManager,
    {} as never,
    {} as PayloadManager,
    sync as unknown as SyncService,
    { publish: jest.fn(), publishSync: jest.fn() } as never,
  )
  return {
    manager,
    sync,
    observers,
    finishSync,
    failSync,
    insert: (value: DecryptedItemInterface) => {
      current = [value]
      for (const observer of observers) {
        observer({ inserted: [value], unerrored: [] })
      }
    },
    replace: (value: DecryptedItemInterface) => {
      current = [value]
    },
  }
}

describe.each(['content type', 'predicate'] as const)('singleton lookup by %s', (kind) => {
  function lookup(manager: SingletonManager) {
    return kind === 'content type'
      ? manager.findOrCreateContentTypeSingleton(contentType, FillItemContent({}))
      : manager.findOrCreateSingleton(new Predicate('content_type', '=', contentType), contentType, FillItemContent({}))
  }

  it('returns the surviving item when sync removes the initially observed singleton', async () => {
    const state = harness()
    const pending = lookup(state.manager)
    state.insert(item('removed-local-preferences'))
    const survivor = item('account-preferences')
    state.replace(survivor)
    state.finishSync()

    expect(await pending).toBe(survivor)
    expect(state.sync.sync).toHaveBeenCalledTimes(1)
    state.manager.deinit()
  })

  it('returns the current immutable snapshot after an item changes during sync', async () => {
    const state = harness()
    const pending = lookup(state.manager)
    state.insert(item('preferences'))
    const updated = item('preferences')
    state.replace(updated)
    state.finishSync()

    expect(await pending).toBe(updated)
    state.manager.deinit()
  })

  it('does not leave a temporary item observer behind when the initial sync fails', async () => {
    const state = harness()
    const observersBefore = state.observers.size
    const pending = lookup(state.manager)
    state.failSync(new Error('sync failed'))

    await expect(pending).rejects.toThrow('sync failed')
    expect(state.observers.size).toBe(observersBefore)
    state.manager.deinit()
  })
})
