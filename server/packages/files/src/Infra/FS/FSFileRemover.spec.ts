import 'reflect-metadata'

import { mkdtemp, mkdir, writeFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { FSFileRemover } from './FSFileRemover'

/**
 * Standard Red Notes: this spec exists because the file it covers had NO test
 * at all and was outside this package's coverage denominator, behind the
 * `'/Infra/FS'` entry in `coveragePathIgnorePatterns`. Measured on inclusion at
 * 19.04 statements / 0 branches / 33.33 functions / 15 lines — the lowest in
 * the package, over code whose whole job is to DELETE the user's files.
 *
 * Driven against a real temporary directory rather than a mocked `fs`. A
 * mocked `fs.promises` is the classic fake that lies here: every bug this
 * adapter can have is a bug in the path it constructs or the order in which it
 * stats and removes, and a mock asserts only that some string was passed to
 * some spy. The real filesystem is the only thing that can tell "removed the
 * right file" from "removed a file".
 */
describe('FSFileRemover', () => {
  let uploadPath: string

  const createRemover = () => new FSFileRemover(uploadPath)

  const seed = async (relativePath: string, contents: string) => {
    const full = join(uploadPath, relativePath)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)

    return full
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
    uploadPath = await mkdtemp(join(tmpdir(), 'srn-fsfileremover-'))
  })

  afterEach(async () => {
    await rm(uploadPath, { recursive: true, force: true })
  })

  describe('remove', () => {
    // The size is read BEFORE the unlink and returned. That ordering is the
    // whole point: the caller debits the user's quota by this number, and a
    // `stat` after the `rm` would throw — so an implementation that reordered
    // these two lines would make every single-file deletion fail.
    it('reports the byte size of the file it deleted, and deletes it', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      const size = await createRemover().remove('user-1/file.txt')

      expect(size).toEqual(10)
      expect(await exists('user-1/file.txt')).toBe(false)
    })

    it('rejects rather than reporting a size of zero when the file is not there', async () => {
      await expect(createRemover().remove('user-1/missing.txt')).rejects.toThrow()
    })
  })

  describe('markFilesToBeRemoved', () => {
    // An account that never uploaded a file has no directory. This MUST be an
    // empty list and not a rejection: it is called on the account-deletion
    // path, and a throw here would abort the deletion of a user who happened
    // never to have used file storage.
    it('answers with an empty list, not an error, when the owner has no directory', async () => {
      const removed = await createRemover().markFilesToBeRemoved('never-uploaded-anything')

      expect(removed).toEqual([])
    })

    it('removes every file under the owner and describes each one', async () => {
      await seed('user-1/first.txt', 'aaa')
      await seed('user-1/second.txt', 'bbbbb')

      const removed = await createRemover().markFilesToBeRemoved('user-1')

      expect(removed).toHaveLength(2)
      expect(removed).toEqual(
        expect.arrayContaining([
          {
            filePath: `${uploadPath}/user-1/first.txt`,
            fileByteSize: 3,
            userOrSharedVaultUuid: 'user-1',
            fileName: 'first.txt',
          },
          {
            filePath: `${uploadPath}/user-1/second.txt`,
            fileByteSize: 5,
            userOrSharedVaultUuid: 'user-1',
            fileName: 'second.txt',
          },
        ]),
      )
      expect(await exists('user-1/first.txt')).toBe(false)
      expect(await exists('user-1/second.txt')).toBe(false)
    })

    // The scoping assertion. This adapter is handed an owner uuid and must
    // touch nothing else — deleting one account's files must not reach into
    // another's, and the two directories are siblings under the same upload
    // root. A path built one `..` wrong, or a `readdir` of the root instead of
    // the owner's subdirectory, would delete a stranger's data; nothing else in
    // this spec would notice.
    it("leaves another owner's files completely untouched", async () => {
      await seed('user-1/mine.txt', 'mine')
      await seed('user-2/theirs.txt', 'theirs')

      const removed = await createRemover().markFilesToBeRemoved('user-1')

      expect(removed.map((description) => description.fileName)).toEqual(['mine.txt'])
      expect(await exists('user-1/mine.txt')).toBe(false)
      expect(await exists('user-2/theirs.txt')).toBe(true)
    })

    it('answers with an empty list for an owner whose directory exists but is empty', async () => {
      await mkdir(join(uploadPath, 'user-1'), { recursive: true })

      expect(await createRemover().markFilesToBeRemoved('user-1')).toEqual([])
    })

    // A shared vault uuid goes down exactly the same path as a user uuid — the
    // parameter is named `userOrSharedVaultUuid` and both are directory names
    // under the upload root. Pinned so the shared-vault deletion path cannot be
    // broken by a change that assumes a user.
    it('treats a shared vault uuid the same way as a user uuid', async () => {
      await seed('vault-1/shared.txt', 'shared')

      const removed = await createRemover().markFilesToBeRemoved('vault-1')

      expect(removed).toEqual([
        {
          filePath: `${uploadPath}/vault-1/shared.txt`,
          fileByteSize: 6,
          userOrSharedVaultUuid: 'vault-1',
          fileName: 'shared.txt',
        },
      ])
    })
  })
})
