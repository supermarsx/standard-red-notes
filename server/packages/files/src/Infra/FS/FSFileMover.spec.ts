import 'reflect-metadata'

import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { FSFileMover } from './FSFileMover'

/**
 * Standard Red Notes: this spec exists because the file it covers had NO test
 * at all and was outside this package's coverage denominator, behind the
 * `'/Infra/FS'` entry in `coveragePathIgnorePatterns`. Measured on inclusion at
 * 58.33 statements / 100 branches / 50 functions / 54.54 lines.
 *
 * Driven against a real temporary directory. The one thing this adapter does
 * that a mock cannot verify is `mkdir(..., { recursive: true })` on the
 * DESTINATION'S PARENT: a mocked `fs` would happily record the call while a
 * real `rename` into a non-existent directory fails with ENOENT. That is the
 * bug this file exists to prevent, so it is tested for real.
 */
describe('FSFileMover', () => {
  let uploadPath: string

  const createMover = () => new FSFileMover(uploadPath)

  const seed = async (relativePath: string, contents: string) => {
    const full = join(uploadPath, relativePath)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }

  const exists = async (relativePath: string) => {
    try {
      await access(join(uploadPath, relativePath))

      return true
    } catch {
      return false
    }
  }

  beforeEach(async () => {
    uploadPath = await mkdtemp(join(tmpdir(), 'srn-fsfilemover-'))
  })

  afterEach(async () => {
    await rm(uploadPath, { recursive: true, force: true })
  })

  it('moves the file to the destination and leaves nothing at the source', async () => {
    await seed('user-1/source.txt', 'payload')
    await mkdir(join(uploadPath, 'user-1/moved'), { recursive: true })

    await createMover().moveFile('user-1/source.txt', 'user-1/moved/destination.txt')

    expect(await exists('user-1/source.txt')).toBe(false)
    expect(await readFile(join(uploadPath, 'user-1/moved/destination.txt'), 'utf8')).toEqual('payload')
  })

  // The case the `mkdir` call is for, and the one a mocked `fs` cannot
  // distinguish: the destination's parent directory does not exist yet. This is
  // the normal shape of the valet-token upload path, where a file is moved into
  // a per-vault directory that may be brand new.
  it('creates the destination directory tree when it does not exist yet', async () => {
    await seed('user-1/source.txt', 'payload')

    await createMover().moveFile('user-1/source.txt', 'vault-9/deeply/nested/destination.txt')

    expect(await readFile(join(uploadPath, 'vault-9/deeply/nested/destination.txt'), 'utf8')).toEqual('payload')
  })

  // Both paths are resolved against the configured upload root rather than the
  // process cwd. A mover that forgot the prefix on either side would silently
  // read or write outside the storage volume.
  it('resolves both the source and the destination under the configured upload root', async () => {
    await seed('a/source.txt', 'payload')

    await createMover().moveFile('a/source.txt', 'b/destination.txt')

    expect(await exists('b/destination.txt')).toBe(true)
    expect(await readFile(join(uploadPath, 'b/destination.txt'), 'utf8')).toEqual('payload')
  })

  it('rejects when the source file does not exist', async () => {
    await expect(createMover().moveFile('user-1/missing.txt', 'user-1/destination.txt')).rejects.toThrow()
  })

  // An overwrite is a real possibility on the upload path (a retried upload of
  // the same chunk) and `rename` is defined to replace the destination. Pinned
  // so a future implementation that switched to `copyFile` + `unlink`, or added
  // an existence guard, cannot silently start rejecting a retry.
  it('replaces an existing destination file', async () => {
    await seed('user-1/source.txt', 'new')
    await seed('user-1/destination.txt', 'old')

    await createMover().moveFile('user-1/source.txt', 'user-1/destination.txt')

    expect(await readFile(join(uploadPath, 'user-1/destination.txt'), 'utf8')).toEqual('new')
  })
})
