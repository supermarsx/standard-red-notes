import 'reflect-metadata'

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

import { FSFileDownloader } from './FSFileDownloader'

/**
 * Standard Red Notes: this spec exists because the file it covers had no
 * dedicated test and was outside this package's coverage denominator, behind
 * the `'/Infra/FS'` entry in `coveragePathIgnorePatterns`. Measured on
 * inclusion at 57.14 statements / 100 branches / 75 functions / 53.84 lines,
 * with `listFiles` entirely uncovered.
 *
 * Driven against a real temporary directory and real read streams. The byte
 * range is the reason: `createReadStream`'s `start`/`end` are INCLUSIVE, and a
 * chunked download that treats `end` as exclusive drops one byte per chunk and
 * corrupts every file large enough to be chunked. Only reading the actual bytes
 * can tell those two implementations apart.
 */
describe('FSFileDownloader', () => {
  let uploadPath: string

  const createDownloader = () => new FSFileDownloader(uploadPath)

  const seed = async (relativePath: string, contents: string) => {
    const full = join(uploadPath, relativePath)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }

  const collect = async (stream: Readable): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }

    return Buffer.concat(chunks).toString('utf8')
  }

  beforeEach(async () => {
    uploadPath = await mkdtemp(join(tmpdir(), 'srn-fsfiledownloader-'))
  })

  afterEach(async () => {
    await rm(uploadPath, { recursive: true, force: true })
  })

  describe('listFiles', () => {
    it('reports every file under the user with its name and byte size', async () => {
      await seed('user-1/first.txt', 'aaa')
      await seed('user-1/second.txt', 'bbbbb')

      const listed = await createDownloader().listFiles('user-1')

      expect(listed).toHaveLength(2)
      expect(listed).toEqual(
        expect.arrayContaining([
          { name: 'first.txt', size: 3 },
          { name: 'second.txt', size: 5 },
        ]),
      )
    })

    // Scoping: the listing is per user, and the directories are siblings under
    // one upload root. A `readdir` of the root rather than the user's
    // subdirectory would disclose the existence of every other account's
    // storage to whoever asked for their own.
    it("does not report another user's files", async () => {
      await seed('user-1/mine.txt', 'mine')
      await seed('user-2/theirs.txt', 'theirs')

      expect(await createDownloader().listFiles('user-1')).toEqual([{ name: 'mine.txt', size: 4 }])
    })

    it('answers with an empty list for a user whose directory is empty', async () => {
      await mkdir(join(uploadPath, 'user-1'), { recursive: true })

      expect(await createDownloader().listFiles('user-1')).toEqual([])
    })

    it('rejects when the user has no directory at all', async () => {
      await expect(createDownloader().listFiles('never-uploaded')).rejects.toThrow()
    })
  })

  describe('getFileSize', () => {
    it('reports the size of the file under the configured upload root', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      expect(await createDownloader().getFileSize('user-1/file.txt')).toEqual(10)
    })

    // Documented limitation, pinned rather than left to a comment: `fs.stat`
    // has no AbortSignal overload, so an already-aborted signal does NOT make
    // this reject. A caller that assumed otherwise would wait on a stat it
    // believed it had cancelled. The bounding happens in the use-case race, not
    // here.
    it('still answers when handed an already-aborted signal, because fs.stat cannot be cancelled', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      expect(await createDownloader().getFileSize('user-1/file.txt', AbortSignal.abort())).toEqual(10)
    })

    it('rejects for a file that does not exist', async () => {
      await expect(createDownloader().getFileSize('user-1/missing.txt')).rejects.toThrow()
    })
  })

  describe('createDownloadStream', () => {
    // INCLUSIVE on both ends. `0..4` over "abcdefghij" is five bytes, not four.
    it('streams the requested byte range inclusively at both ends', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      const stream = await createDownloader().createDownloadStream('user-1/file.txt', 0, 4)

      expect(await collect(stream)).toEqual('abcde')
    })

    it('streams a range that starts part way into the file', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      const stream = await createDownloader().createDownloadStream('user-1/file.txt', 3, 6)

      expect(await collect(stream)).toEqual('defg')
    })

    it('streams a single byte when start and end are the same', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      const stream = await createDownloader().createDownloadStream('user-1/file.txt', 9, 9)

      expect(await collect(stream)).toEqual('j')
    })

    // Unlike `getFileSize`, the STREAM does honour the signal — this is the
    // asymmetry inside this one class, and the half that actually cancels. An
    // aborted download must stop delivering bytes rather than run to
    // completion against a client that has gone away.
    it('fails the stream when the abort signal is already aborted', async () => {
      await seed('user-1/file.txt', 'abcdefghij')

      const stream = await createDownloader().createDownloadStream('user-1/file.txt', 0, 9, AbortSignal.abort())

      await expect(collect(stream)).rejects.toThrow()
    })

    // The stream is created lazily, so a missing file surfaces as a stream
    // error rather than a rejected promise. Pinned because a caller that only
    // awaited the factory and never listened for 'error' would hit an
    // unhandled rejection and take the process down.
    it('surfaces a missing file as a stream error, not a rejected factory call', async () => {
      const stream = await createDownloader().createDownloadStream('user-1/missing.txt', 0, 9)

      expect(stream).toBeInstanceOf(Readable)
      await expect(collect(stream)).rejects.toThrow()
    })
  })
})
