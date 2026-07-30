const TemporaryFilePrefix = 'standard-red-notes'
const MaximumExtensionLength = 16

function hasInvalidFileNameCharacter(filename: string): boolean {
  return Array.from(filename).some((character) => {
    const characterCode = character.charCodeAt(0)
    return character === '/' || character === '\\' || characterCode <= 31 || characterCode === 127
  })
}

export function assertSafeMobileFileName(filename: string): string {
  const trimmed = filename.trim()

  if (!trimmed || trimmed === '.' || trimmed === '..' || hasInvalidFileNameCharacter(trimmed)) {
    throw new Error('Invalid mobile file name')
  }

  return trimmed
}

function safeExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return ''
  }

  const extension = filename.slice(lastDot + 1)
  if (extension.length > MaximumExtensionLength || !/^[a-zA-Z0-9]+$/.test(extension)) {
    return ''
  }

  return `.${extension}`
}

export function createTemporaryMobileFileName(filename: string, uniqueToken: string): string {
  const safeFilename = assertSafeMobileFileName(filename)
  if (!/^[a-zA-Z0-9_-]+$/.test(uniqueToken)) {
    throw new Error('Invalid temporary file token')
  }

  return `${TemporaryFilePrefix}-${uniqueToken}${safeExtension(safeFilename)}`
}

/**
 * Mobile filesystem paths are POSIX-style on both supported platforms. The
 * filename is validated as one basename before joining, then the final prefix
 * is checked as a second containment boundary before any unlink/write.
 */
export function createContainedMobileFilePath(directory: string, filename: string): string {
  const safeFilename = assertSafeMobileFileName(filename)
  const normalizedDirectory = directory === '/' ? directory : directory.replace(/\/+$/, '')
  const directorySegments = normalizedDirectory.split('/')

  if (
    !normalizedDirectory.startsWith('/') ||
    directorySegments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Mobile file directory must be absolute')
  }

  const directoryPrefix = normalizedDirectory === '/' ? '/' : `${normalizedDirectory}/`
  const destination = `${directoryPrefix}${safeFilename}`
  if (!destination.startsWith(directoryPrefix)) {
    throw new Error('Mobile file path escapes its destination directory')
  }

  return destination
}
