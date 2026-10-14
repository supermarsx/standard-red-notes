/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import AccountStorage from './AccountStorage'

jest.mock('@standardnotes/snjs', () => ({
  isErrorResponse: (value: { error?: unknown }) => Boolean(value.error),
  SettingName: {
    NAMES: { FileUploadBytesUsed: 'quota-used', FileUploadBytesLimit: 'quota-limit' },
    create: (value: string) => ({ getValue: () => value }),
  },
}))
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
const fixture = (entitledToFiles = true) => ({
  featuresController: { entitledToFiles },
  sessions: { getUser: () => ({ uuid: 'account' }), isSignedIntoFirstPartyServer: () => true },
  settings: {
    getSubscriptionSetting: jest.fn(async (name: string) => (name === 'quota-used' ? '1048576' : '10485760')),
  },
  legacyApi: {
    getAccountStorageUsage: jest.fn(async () => ({
      data: {
        itemBytesUsed: 100,
        itemsMeasured: 1,
        itemsUnmeasured: 0,
        totalBytesUsed: 600,
        complete: true,
        measuredAt: '2026-10-14T12:00:00Z',
        components: {
          items: { bytes: 100, count: 1, complete: true },
          files: { bytes: 200, count: 1, complete: true },
          revisions: { bytes: 300, count: 1, complete: true },
        },
      },
    })),
  },
})
it('combines measured usage and a clearly separate quota counter under one Storage heading', async () => {
  const app = fixture()
  await act(async () => root.render(createElement(AccountStorage, { application: app as never })))
  const headings = Array.from(container.querySelectorAll('h2,h3,h4')).map((element) => element.textContent)
  expect(headings).toEqual(['Storage', 'File upload allowance'])
  expect(container.querySelector('[data-test-id="storage-total"]')?.textContent).toContain('600 B')
  const fileRow = Array.from(container.querySelectorAll('dl > div')).find(
    (element) => element.querySelector('dt')?.textContent === 'Uploaded files',
  )
  expect(fileRow?.textContent).toContain('200 B')
  expect(container.textContent).toContain('Upload quota counter: 1 MB')
  expect(container.textContent).toContain('may differ from measured uploaded file data')
  expect(container.querySelector('progress')?.value).toBe(1048576)
  expect(container.querySelector('details')?.open).toBe(false)
  expect(container.textContent).toContain('2026-10-14 12:00:00.000 UTC')
})
it('keeps the measured summary for accounts without a file upload entitlement', async () => {
  const app = fixture(false)
  await act(async () => root.render(createElement(AccountStorage, { application: app as never })))
  expect(container.textContent).toContain('Total measured storage')
  expect(container.textContent).not.toContain('File upload allowance')
  expect(app.settings.getSubscriptionSetting).not.toHaveBeenCalled()
})
