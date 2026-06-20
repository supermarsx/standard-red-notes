import {
  DirectoryEntryLike,
  filesWithPathsFromInput,
  flattenDirectoryEntries,
  flattenDirectoryEntry,
  folderSegmentsForPath,
  hasAnyFolders,
  normalizeEntryPath,
  topLevelFolderName,
} from './DirectoryUpload'

const fakeFile = (name: string): File => new File(['x'], name, { type: 'text/plain' })

const fileEntry = (name: string, fullPath: string): DirectoryEntryLike =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (success: (file: File) => void) => success(fakeFile(name)),
  }) as unknown as DirectoryEntryLike

const dirEntry = (name: string, fullPath: string, children: DirectoryEntryLike[]): DirectoryEntryLike => {
  // Emulate the batched readEntries contract: first call returns the children, second returns [].
  let served = false
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => ({
      readEntries: (success: (entries: DirectoryEntryLike[]) => void) => {
        if (served) {
          success([])
          return
        }
        served = true
        success(children)
      },
    }),
  } as unknown as DirectoryEntryLike
}

describe('normalizeEntryPath', () => {
  it('strips leading slashes', () => {
    expect(normalizeEntryPath('/photos/a.jpg')).toBe('photos/a.jpg')
    expect(normalizeEntryPath('photos/a.jpg')).toBe('photos/a.jpg')
  })
})

describe('folderSegmentsForPath', () => {
  it('returns folders excluding the file name', () => {
    expect(folderSegmentsForPath('photos/2024/a.jpg')).toEqual(['photos', '2024'])
  })

  it('returns empty array for a flat file', () => {
    expect(folderSegmentsForPath('a.jpg')).toEqual([])
  })

  it('ignores empty, dot and double-dot segments', () => {
    expect(folderSegmentsForPath('photos//./../sub/a.jpg')).toEqual(['photos', 'sub'])
  })
})

describe('topLevelFolderName', () => {
  it('returns the shared top-level folder', () => {
    expect(topLevelFolderName(['root/a.jpg', 'root/sub/b.jpg'])).toBe('root')
  })

  it('returns undefined when a path is flat', () => {
    expect(topLevelFolderName(['root/a.jpg', 'b.jpg'])).toBeUndefined()
  })

  it('returns undefined when tops differ', () => {
    expect(topLevelFolderName(['a/x.jpg', 'b/y.jpg'])).toBeUndefined()
  })
})

describe('hasAnyFolders', () => {
  it('detects nested paths', () => {
    expect(hasAnyFolders(['a.jpg', 'b.jpg'])).toBe(false)
    expect(hasAnyFolders(['a.jpg', 'sub/b.jpg'])).toBe(true)
  })
})

describe('filesWithPathsFromInput', () => {
  it('uses webkitRelativePath when present, else the name', () => {
    const withPath = Object.assign(fakeFile('a.jpg'), { webkitRelativePath: 'MyFolder/sub/a.jpg' })
    const flat = fakeFile('b.jpg')
    const result = filesWithPathsFromInput([withPath, flat])
    expect(result.map((r) => r.path)).toEqual(['MyFolder/sub/a.jpg', 'b.jpg'])
  })
})

describe('flattenDirectoryEntry', () => {
  it('flattens a nested tree into {file, path} pairs', async () => {
    const tree = dirEntry('root', '/root', [
      fileEntry('a.jpg', '/root/a.jpg'),
      dirEntry('sub', '/root/sub', [fileEntry('b.jpg', '/root/sub/b.jpg')]),
    ])

    const result = await flattenDirectoryEntry(tree)
    expect(result.map((r) => r.path).sort()).toEqual(['root/a.jpg', 'root/sub/b.jpg'])
    expect(result.every((r) => r.file instanceof File)).toBe(true)
  })

  it('returns one pair for a single dropped file', async () => {
    const result = await flattenDirectoryEntry(fileEntry('a.jpg', '/a.jpg'))
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('a.jpg')
  })

  it('flattens a mix of files and directories', async () => {
    const result = await flattenDirectoryEntries([
      fileEntry('top.txt', '/top.txt'),
      dirEntry('docs', '/docs', [fileEntry('c.txt', '/docs/c.txt')]),
    ])
    expect(result.map((r) => r.path).sort()).toEqual(['docs/c.txt', 'top.txt'])
  })
})
