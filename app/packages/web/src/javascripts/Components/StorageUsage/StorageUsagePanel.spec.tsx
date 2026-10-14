/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import StorageUsagePanel from './StorageUsagePanel'
jest.mock('@standardnotes/snjs', () => ({ isErrorResponse: (value: { error?: unknown }) => Boolean(value.error) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const complete = {
  itemBytesUsed: 100,
  itemsMeasured: 1,
  itemsUnmeasured: 0,
  totalBytesUsed: 600,
  complete: true,
  components: {
    items: { bytes: 100, count: 1, complete: true },
    files: { bytes: 200, count: 1, complete: true },
    revisions: { bytes: 300, count: 1, complete: true },
  },
}
const fixture = () => ({
  sessions: { getUser: () => ({ uuid: 'operator' }) },
  legacyApi: {
    getAccountStorageUsage: jest.fn(async (): Promise<unknown> => ({ data: complete })),
    adminGetUserStorageUsage: jest.fn(async (_userUuid: string): Promise<unknown> => ({ data: complete })),
  },
})
it('uses caller storage in Account and the explicit selected target in admin', async () => {
  const app = fixture()
  await act(async () => root.render(createElement(StorageUsagePanel, { application: app as never })))
  expect(app.legacyApi.getAccountStorageUsage).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('600 B')
  expect(container.textContent).toContain('Saved revisions')
  await act(async () =>
    root.render(createElement(StorageUsagePanel, { application: app as never, userUuid: 'target' })),
  )
  expect(app.legacyApi.adminGetUserStorageUsage).toHaveBeenCalledWith('target')
})
it('does not automatically measure offscreen or unsupported-visibility rows', async () => {
  const app = fixture()
  await act(async () =>
    root.render(
      createElement(StorageUsagePanel, { application: app as never, userUuid: 'target', compact: true, lazy: true }),
    ),
  )
  expect(app.legacyApi.adminGetUserStorageUsage).not.toHaveBeenCalled()
  await act(async () => {
    container.querySelector('button')!.click()
    await Promise.resolve()
  })
  expect(app.legacyApi.adminGetUserStorageUsage).toHaveBeenCalledWith('target')
})
it('limits concurrent visible measurements to four and does not dispatch queued rows after they unmount', async () => {
  const app = fixture(),
    resolvers: Array<(response: unknown) => void> = []
  app.legacyApi.adminGetUserStorageUsage.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      }),
  )
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        ...Array.from({ length: 8 }, (_, index) =>
          createElement(StorageUsagePanel, {
            key: index,
            application: app as never,
            userUuid: `user-${index}`,
            compact: true,
          }),
        ),
      ),
    ),
  )
  expect(app.legacyApi.adminGetUserStorageUsage).toHaveBeenCalledTimes(4)
  await act(async () => root.render(null))
  await act(async () => {
    resolvers.forEach((resolve) => resolve({ data: complete }))
    await Promise.resolve()
  })
  expect(app.legacyApi.adminGetUserStorageUsage).toHaveBeenCalledTimes(4)
})
it('rejects a late response for an old target and retains an explicit retry after measurement failure', async () => {
  const app = fixture()
  let finish!: (response: unknown) => void
  app.legacyApi.adminGetUserStorageUsage
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce({ error: { message: 'Unavailable' } })
    .mockResolvedValueOnce({ data: complete })
  await act(async () => root.render(createElement(StorageUsagePanel, { application: app as never, userUuid: 'old' })))
  await act(async () => root.render(createElement(StorageUsagePanel, { application: app as never, userUuid: 'new' })))
  await act(async () => {
    finish({ data: complete })
    await Promise.resolve()
  })
  expect(container.textContent).not.toContain('600 B')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => {
    container.querySelector('button')!.click()
    await Promise.resolve()
  })
  expect(container.textContent).toContain('600 B')
})
