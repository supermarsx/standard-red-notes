import { createHash } from 'crypto'
import path from 'path'
import { sanitizeFileName } from '@standardnotes/utils'

const TextBackupFileExtension = '.txt'
const MaxPlaintextBackupPathSegmentLength = 160
const WindowsReservedFileName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const UnsafeObjectPropertyNames = new Set(['__proto__', 'prototype', 'constructor'])

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some(isControlCharacter)
}

function truncateToUtf16Length(value: string, maxLength: number): string {
  let result = ''
  for (const character of value) {
    if (result.length + character.length > maxLength) {
      break
    }
    result += character
  }
  return result
}

export function sanitizePlaintextBackupPathSegment(value: string, fallback: string): string {
  const withoutControlCharacters = Array.from(value)
    .map((character) => (isControlCharacter(character) ? '_' : character))
    .join('')
  let result = sanitizeFileName(withoutControlCharacters).replace(/[ .]+$/g, '')

  if (!result || result === '.' || result === '..') {
    result = fallback
  }
  if (WindowsReservedFileName.test(result)) {
    result = `_${result}`
  }

  return truncateToUtf16Length(result, MaxPlaintextBackupPathSegmentLength)
}

export function createPlaintextBackupFileName(baseName: string, uuid: string): string {
  /**
   * Keep the full compact UUID. The previous four-character suffix had only
   * 65,536 possibilities, so two same-titled notes in the same tag could
   * overwrite one another and later delete each other's backup.
   */
  const compactUuid = uuid.replace(/[^a-zA-Z0-9]/g, '') || 'note'
  const condensedUuid =
    compactUuid.length <= 64
      ? compactUuid
      : `${compactUuid.slice(0, 47)}-${createHash('sha256').update(uuid).digest('hex').slice(0, 16)}`
  const sanitizedBaseName = sanitizePlaintextBackupPathSegment(baseName, 'Untitled')

  return `${sanitizedBaseName}-${condensedUuid}${TextBackupFileExtension}`
}

export function createPlaintextBackupRelativePath(filename: string, tag?: string): string {
  const tagDirectory = tag !== undefined ? sanitizePlaintextBackupPathSegment(tag, 'Untagged') : undefined
  return tagDirectory ? path.join(tagDirectory, filename) : filename
}

export function resolvePathInsideDirectory(directory: string, ...segments: string[]): string {
  const resolvedDirectory = path.resolve(directory)
  const resolvedPath = path.resolve(resolvedDirectory, ...segments)
  const relativePath = path.relative(resolvedDirectory, resolvedPath)

  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Refusing to access a backup path outside its configured directory')
  }

  return resolvedPath
}

export function resolveMappedPlaintextBackupPath(directory: string, recordedPath: unknown): string | undefined {
  if (typeof recordedPath !== 'string' || !recordedPath || path.isAbsolute(recordedPath)) {
    return undefined
  }

  /**
   * Mapping files are persisted across platforms, so treat both slash styles
   * as separators. Reject traversal and the private settings directory before
   * resolving the path against the configured backup root.
   */
  const segments = recordedPath.split(/[\\/]/)
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /^[a-zA-Z]:$/.test(segment) ||
        containsControlCharacters(segment),
    ) ||
    segments[0].toLowerCase() === '.settings' ||
    path.extname(segments[segments.length - 1]).toLowerCase() !== TextBackupFileExtension
  ) {
    return undefined
  }

  try {
    return resolvePathInsideDirectory(directory, ...segments)
  } catch {
    return undefined
  }
}

export function isSafeBackupDirectoryName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MaxPlaintextBackupPathSegmentLength &&
    value === value.trim() &&
    !/[ .]$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !WindowsReservedFileName.test(value) &&
    !UnsafeObjectPropertyNames.has(value) &&
    !/[<>:"/\\|?*]/.test(value) &&
    !containsControlCharacters(value)
  )
}
