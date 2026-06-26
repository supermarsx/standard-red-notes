import { WebApplication } from '@/Application/WebApplication'
import { hasPendingUnsavedChanges } from './useUnsavedChangesWarning'

type MockApplication = {
  isLaunched: () => boolean
  sync: { getSyncStatus: () => { syncInProgress: boolean } }
  items: { getDirtyItems: () => unknown[] }
}

const makeApplication = (opts: {
  launched?: boolean
  syncInProgress?: boolean
  dirtyCount?: number
  throwOnRead?: boolean
}): WebApplication => {
  const app: MockApplication = {
    isLaunched: () => opts.launched ?? true,
    sync: {
      getSyncStatus: () => {
        if (opts.throwOnRead) {
          throw new Error('boom')
        }
        return { syncInProgress: opts.syncInProgress ?? false }
      },
    },
    items: {
      getDirtyItems: () => new Array(opts.dirtyCount ?? 0).fill({}),
    },
  }
  return app as unknown as WebApplication
}

describe('hasPendingUnsavedChanges', () => {
  it('warns when there are dirty items not yet persisted/pushed', () => {
    expect(hasPendingUnsavedChanges(makeApplication({ dirtyCount: 1 }))).toBe(true)
  })

  it('warns when a sync/local-save is in progress (even with no dirty items)', () => {
    expect(hasPendingUnsavedChanges(makeApplication({ syncInProgress: true, dirtyCount: 0 }))).toBe(true)
  })

  it('is silent when clean and idle', () => {
    expect(hasPendingUnsavedChanges(makeApplication({ syncInProgress: false, dirtyCount: 0 }))).toBe(false)
  })

  it('is silent before the app has launched', () => {
    expect(hasPendingUnsavedChanges(makeApplication({ launched: false, dirtyCount: 5 }))).toBe(false)
  })

  it('is silent (does not block leaving) if reading state throws', () => {
    expect(hasPendingUnsavedChanges(makeApplication({ throwOnRead: true }))).toBe(false)
  })
})
