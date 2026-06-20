/**
 * Standard Red Notes: pure helpers for bulk-file and whole-folder uploads.
 *
 * These functions are intentionally framework- and DOM-light so they can be unit
 * tested in isolation:
 *  - flattening a dropped directory-entry tree (`FileSystemEntry`) into
 *    `{ file, path }` pairs,
 *  - reading paths off `<input webkitdirectory>` selections,
 *  - turning a relative path into the ordered list of folder-name segments it
 *    should live under, and deriving the top-level folder name of a batch.
 */

/** A file to upload, paired with its POSIX-style relative path (e.g. `photos/2024/a.jpg`). */
export type FileWithPath = {
  file: File
  /** Path relative to the dropped/selected root, using `/` separators. May equal `file.name` when flat. */
  path: string
}

/**
 * Minimal structural type for the non-standard `FileSystemEntry` API exposed by
 * `DataTransferItem.webkitGetAsEntry()`. We model only what we use so we can test
 * the walk without a real browser.
 */
export interface DirectoryEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  /** Full path including a leading slash, e.g. `/photos/a.jpg`, per the spec. */
  fullPath: string
}

export interface FileEntryLike extends DirectoryEntryLike {
  isFile: true
  file(success: (file: File) => void, failure?: (error: unknown) => void): void
}

export interface DirectoryReaderLike {
  readEntries(success: (entries: DirectoryEntryLike[]) => void, failure?: (error: unknown) => void): void
}

export interface DirEntryLike extends DirectoryEntryLike {
  isDirectory: true
  createReader(): DirectoryReaderLike
}

const isFileEntry = (entry: DirectoryEntryLike): entry is FileEntryLike => entry.isFile
const isDirEntry = (entry: DirectoryEntryLike): entry is DirEntryLike => entry.isDirectory

/** Normalize an entry `fullPath` (which the spec gives a leading slash) into a clean relative path. */
export const normalizeEntryPath = (fullPath: string): string => fullPath.replace(/^\/+/, '')

const getFileFromEntry = (entry: FileEntryLike): Promise<File> =>
  new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })

const readAllEntries = (reader: DirectoryReaderLike): Promise<DirectoryEntryLike[]> => {
  // `readEntries` returns results in batches and must be called repeatedly until
  // it yields an empty array, otherwise large directories are silently truncated.
  const all: DirectoryEntryLike[] = []
  const readBatch = (): Promise<DirectoryEntryLike[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })

  const loop = async (): Promise<DirectoryEntryLike[]> => {
    const batch = await readBatch()
    if (batch.length === 0) {
      return all
    }
    all.push(...batch)
    return loop()
  }

  return loop()
}

/**
 * Recursively walk a dropped `FileSystemEntry` tree into a flat list of
 * `{ file, path }` pairs. `path` is the entry's relative path so callers can
 * recreate the folder structure. A single dropped file yields one pair whose
 * path is just the file name.
 */
export const flattenDirectoryEntry = async (entry: DirectoryEntryLike): Promise<FileWithPath[]> => {
  if (isFileEntry(entry)) {
    const file = await getFileFromEntry(entry)
    return [{ file, path: normalizeEntryPath(entry.fullPath) || file.name }]
  }

  if (isDirEntry(entry)) {
    const children = await readAllEntries(entry.createReader())
    const nested = await Promise.all(children.map((child) => flattenDirectoryEntry(child)))
    return nested.flat()
  }

  return []
}

/** Flatten several dropped entries (mix of files and directories) into one list. */
export const flattenDirectoryEntries = async (entries: DirectoryEntryLike[]): Promise<FileWithPath[]> => {
  const lists = await Promise.all(entries.map((entry) => flattenDirectoryEntry(entry)))
  return lists.flat()
}

/**
 * Build `{ file, path }` pairs from a `<input webkitdirectory>` / multi-file
 * selection. When the input is a directory selection each `File` carries a
 * `webkitRelativePath` (e.g. `MyFolder/sub/a.jpg`); for a plain multi-file
 * selection it is empty and we fall back to the file name.
 */
export const filesWithPathsFromInput = (files: ArrayLike<File>): FileWithPath[] => {
  return Array.from(files).map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    return { file, path: relative && relative.length > 0 ? relative : file.name }
  })
}

/**
 * Split a relative path into the ordered list of folder-name segments the file
 * should be filed under (i.e. everything except the final filename component).
 * Returns an empty array for a flat path with no folders.
 */
export const folderSegmentsForPath = (path: string): string[] => {
  const segments = path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  // Drop the final segment (the file name itself).
  return segments.slice(0, -1)
}

/**
 * The single top-level folder name shared by a batch of paths, or undefined when
 * the batch has no common top-level folder (e.g. plain multi-file selection, or
 * files dropped from differing roots). Used to name a flat fallback folder.
 */
export const topLevelFolderName = (paths: string[]): string | undefined => {
  const tops = new Set<string>()
  for (const path of paths) {
    const segments = folderSegmentsForPath(path)
    if (segments.length === 0) {
      return undefined
    }
    tops.add(segments[0])
  }
  if (tops.size !== 1) {
    return undefined
  }
  return [...tops][0]
}

/** True when at least one path describes a nested folder structure. */
export const hasAnyFolders = (paths: string[]): boolean => paths.some((path) => folderSegmentsForPath(path).length > 0)
