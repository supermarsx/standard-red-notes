import { presentStorageUsage } from './storageUsage'
const usage = () => ({
  itemBytesUsed: 100,
  itemsMeasured: 2,
  itemsUnmeasured: 0,
  totalBytesUsed: 600,
  complete: true,
  components: {
    items: { bytes: 100, count: 2, complete: true },
    files: { bytes: 200, count: 1, complete: true },
    revisions: { bytes: 300, count: 3, complete: true },
  },
})
it('includes all three independently measured components in the exact total', () => {
  expect(presentStorageUsage(usage())).toMatchObject({
    complete: true,
    total: '600 B',
    parts: [
      { key: 'items', text: '100 B' },
      { key: 'files', text: '200 B' },
      { key: 'revisions', text: '300 B' },
    ],
  })
})
it('never prints a complete total for missing files, revisions or an incomplete component', () => {
  const missing = usage()
  missing.components.files = { bytes: null as unknown as number, count: null as unknown as number, complete: false }
  missing.complete = false
  missing.totalBytesUsed = null as unknown as number
  expect(presentStorageUsage(missing)).toMatchObject({
    complete: false,
    total: 'Unavailable',
    parts: [{}, { text: 'Not fully measured' }, {}],
  })
  expect(presentStorageUsage({ itemBytesUsed: 100, itemsMeasured: 2, itemsUnmeasured: 0 })).toMatchObject({
    complete: false,
    total: 'Unavailable',
  })
})
it('distinguishes a fully measured zero from an inconsistent sum', () => {
  const zero = usage()
  zero.totalBytesUsed = 0
  Object.values(zero.components).forEach((part) => {
    part.bytes = 0
    part.count = 0
  })
  expect(presentStorageUsage(zero)).toMatchObject({ complete: true, total: '0 B' })
  const wrong = usage()
  wrong.totalBytesUsed = 999
  expect(presentStorageUsage(wrong).complete).toBe(false)
})
