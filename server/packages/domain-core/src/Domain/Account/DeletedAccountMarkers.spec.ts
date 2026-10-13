import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  DELETED_ACCOUNT_MARKERS_DIRECTORY_NAME,
  DeletedAccountMarkers,
  deletedAccountMarkersDirectory,
} from './DeletedAccountMarkers'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'

describe('deletedAccountMarkersDirectory', () => {
  it('is a fixed directory name beside the shared settings file', () => {
    expect(DELETED_ACCOUNT_MARKERS_DIRECTORY_NAME).toBe('deleted-accounts')
    expect(deletedAccountMarkersDirectory(path.join(os.tmpdir(), 'srn', 'server-settings.json'))).toBe(
      path.join(os.tmpdir(), 'srn', 'deleted-accounts'),
    )
  })

  it('gives every process the same answer for the same settings path, however it is spelled', () => {
    const base = path.join(os.tmpdir(), 'srn')

    expect(deletedAccountMarkersDirectory(`  ${path.join(base, 'server-settings.json')}  `)).toBe(
      deletedAccountMarkersDirectory(path.join(base, 'nested', '..', 'server-settings.json')),
    )
  })

  it.each([undefined, null, '', '   '])('is undefined when no shared settings path is configured (%p)', (value) => {
    expect(deletedAccountMarkersDirectory(value)).toBeUndefined()
  })
})

describe('DeletedAccountMarkers', () => {
  let root: string
  let directory: string
  let markers: DeletedAccountMarkers

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-markers-'))
    directory = path.join(root, 'deleted-accounts')
    markers = new DeletedAccountMarkers(directory)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates nothing until an account is recorded', async () => {
    expect(await markers.list()).toEqual([])
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('records an account as an empty file named by its id, and lists it', async () => {
    expect(await markers.add(ALICE)).toBe(true)
    expect(await markers.add(BOB)).toBe(true)

    expect(await markers.list()).toEqual([ALICE, BOB])
    expect((await fs.readdir(directory)).sort()).toEqual([ALICE, BOB])
    expect((await fs.stat(path.join(directory, ALICE))).size).toBe(0)
  })

  it('is idempotent: recording twice leaves one marker, and does not disturb it', async () => {
    await markers.add(ALICE)
    const first = await fs.stat(path.join(directory, ALICE))

    expect(await markers.add(ALICE)).toBe(true)

    expect(await markers.list()).toEqual([ALICE])
    expect((await fs.stat(path.join(directory, ALICE))).birthtimeMs).toBe(first.birthtimeMs)
  })

  it('treats an upper-case spelling as the same account', async () => {
    // An id with letters in it: one made of digits alone has no upper case.
    const carol = 'abcdef12-3456-4abc-8def-abcdef123456'
    expect(carol.toUpperCase()).not.toBe(carol)

    expect(await markers.add(carol.toUpperCase())).toBe(true)

    expect(await markers.list()).toEqual([carol])
    expect(await markers.remove(carol.toUpperCase())).toBe(true)
    expect(await markers.list()).toEqual([])
  })

  it('removes one marker and leaves the others; removing a missing one is not a failure', async () => {
    await markers.add(ALICE)
    await markers.add(BOB)

    expect(await markers.remove(ALICE)).toBe(true)
    expect(await markers.remove(ALICE)).toBe(true)

    expect(await markers.list()).toEqual([BOB])
  })

  it('says a marker is NOT gone when it could not be removed', async () => {
    // Something that cannot be unlinked sits under the account's name. The
    // caller counts a deletion as finished only on `true`.
    await fs.mkdir(path.join(directory, ALICE), { recursive: true })

    expect(await markers.remove(ALICE)).toBe(false)
    expect(await fs.readdir(directory)).toEqual([ALICE])
  })

  it.each([
    '',
    '..',
    '../escape',
    '..\\escape',
    `${ALICE}/../x`,
    `${ALICE}.json`,
    ` ${ALICE}`,
    'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
    'not-an-id',
    undefined,
    null,
    42,
  ])('records and removes nothing for %p', async (value) => {
    expect(await markers.add(value as string)).toBe(false)
    expect(await markers.remove(value as string)).toBe(false)
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('reads back only files that have the exact shape of an account id', async () => {
    await markers.add(ALICE)
    await fs.writeFile(path.join(directory, 'notes.txt'), 'x')
    await fs.writeFile(path.join(directory, `${BOB}.tmp`), '')
    await fs.writeFile(path.join(directory, BOB.toUpperCase()), '')
    await fs.mkdir(path.join(directory, '33333333-3333-4333-8333-333333333333'))

    // A directory with an id for a name is not a marker, and neither is the
    // upper-case file on a file system that keeps the two apart.
    expect((await markers.list()).filter((id) => id !== BOB)).toEqual([ALICE])
  })

  it('reports failure instead of throwing when the directory cannot be created', async () => {
    const blocked = path.join(root, 'a-file')
    await fs.writeFile(blocked, 'x')
    const unwritable = new DeletedAccountMarkers(path.join(blocked, 'deleted-accounts'))

    await expect(unwritable.add(ALICE)).resolves.toBe(false)
    await expect(unwritable.list()).resolves.toEqual([])
    // Whether removing under a path that is not a directory counts as "gone"
    // differs by platform; what matters is that it does not throw.
    await expect(unwritable.remove(ALICE)).resolves.toEqual(expect.any(Boolean))
  })

  it('tells an unreadable record apart from an empty one', async () => {
    // Not there yet: nothing has been recorded. That is an answer.
    expect(await markers.read()).toEqual([])

    await markers.add(ALICE)
    expect(await markers.read()).toEqual([ALICE])

    // Something that is not a directory sits where the record should be. The
    // same answer as a directory this process may not open.
    const notADirectory = path.join(root, 'in-the-way')
    await fs.writeFile(notADirectory, 'x')
    const unreadable = new DeletedAccountMarkers(notADirectory)

    expect(await unreadable.read()).toBeUndefined()
    expect(await unreadable.list()).toEqual([])
    expect(await unreadable.add(ALICE)).toBe(false)
  })

  it('does nothing at all when no location is configured', async () => {
    const unconfigured = new DeletedAccountMarkers(undefined)

    expect(unconfigured.isConfigured()).toBe(false)
    expect(markers.isConfigured()).toBe(true)
    expect(await unconfigured.add(ALICE)).toBe(false)
    expect(await unconfigured.list()).toEqual([])
    expect(await unconfigured.read()).toEqual([])
    expect(await unconfigured.remove(ALICE)).toBe(false)
  })
})
