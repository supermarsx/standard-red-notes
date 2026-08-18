export type FilePreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'unsupported'

export type TextPreviewLanguage =
  | 'plain'
  | 'openvpn'
  | 'json'
  | 'markup'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'css'
  | 'shell'
  | 'powershell'
  | 'sql'
  | 'diff'
  | 'code'

export type FilePreviewMetadata = {
  mimeType?: string | null
  name?: string | null
}

export const PreviewableTextFileTypes = [
  'text/plain',
  'text/csv',
  'application/json',
  'application/xml',
  'application/x-openvpn-profile',
]

export const RequiresNativeFilePreview = ['application/pdf']

const SupportedImageFileTypes = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
])

const ImageExtensionsByMimeType: Record<string, Set<string>> = {
  'image/apng': new Set(['.apng', '.png']),
  'image/avif': new Set(['.avif']),
  'image/bmp': new Set(['.bmp']),
  'image/gif': new Set(['.gif']),
  'image/jpeg': new Set(['.jfif', '.jpe', '.jpeg', '.jpg']),
  'image/png': new Set(['.png']),
  'image/vnd.microsoft.icon': new Set(['.cur', '.ico']),
  'image/webp': new Set(['.webp']),
  'image/x-icon': new Set(['.cur', '.ico']),
}

const OpaqueFileTypes = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'application/x-unknown',
  'application/x-empty',
])

const StructuredTextFileTypes = new Set([
  'application/csv',
  'application/ecmascript',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/markdown',
  'application/openvpn-profile',
  'application/problem+json',
  'application/rtf',
  'application/sql',
  'application/toml',
  'application/vnd.openvpn',
  'application/x-bash',
  'application/x-csh',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-ndjson',
  'application/x-openvpn-profile',
  'application/x-perl',
  'application/x-php',
  'application/x-python',
  'application/x-ruby',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-tex',
  'application/x-toml',
  'application/x-yaml',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
])

const ExtensionLanguages: Record<string, TextPreviewLanguage> = {
  '.asm': 'code',
  '.bash': 'shell',
  '.bat': 'shell',
  '.bib': 'code',
  '.c': 'code',
  '.cc': 'code',
  '.cer': 'plain',
  '.cfg': 'ini',
  '.cljs': 'code',
  '.clj': 'code',
  '.cmd': 'shell',
  '.cnf': 'ini',
  '.conf': 'ini',
  '.config': 'ini',
  '.cpp': 'code',
  '.crt': 'plain',
  '.cs': 'code',
  '.css': 'css',
  '.csv': 'plain',
  '.cts': 'typescript',
  '.cxx': 'code',
  '.dart': 'code',
  '.diff': 'diff',
  '.env': 'ini',
  '.erl': 'code',
  '.ex': 'code',
  '.exs': 'code',
  '.fish': 'shell',
  '.fs': 'code',
  '.fsx': 'code',
  '.gitattributes': 'ini',
  '.gitignore': 'plain',
  '.gql': 'code',
  '.gradle': 'code',
  '.graphql': 'code',
  '.groovy': 'code',
  '.h': 'code',
  '.hpp': 'code',
  '.hrl': 'code',
  '.htm': 'markup',
  '.html': 'markup',
  '.http': 'code',
  '.ics': 'plain',
  '.ini': 'ini',
  '.java': 'code',
  '.js': 'javascript',
  '.json': 'json',
  '.json5': 'json',
  '.jsonl': 'json',
  '.jsx': 'javascript',
  '.key': 'plain',
  '.kt': 'code',
  '.kts': 'code',
  '.less': 'css',
  '.log': 'plain',
  '.lua': 'code',
  '.markdown': 'markdown',
  '.md': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.mjs': 'javascript',
  '.mobileconfig': 'markup',
  '.mts': 'typescript',
  '.ndjson': 'json',
  '.npmrc': 'ini',
  '.ovpn': 'openvpn',
  '.patch': 'diff',
  '.pem': 'plain',
  '.php': 'code',
  '.pl': 'code',
  '.properties': 'ini',
  '.proto': 'code',
  '.ps1': 'powershell',
  '.psd1': 'powershell',
  '.psm1': 'powershell',
  '.pub': 'plain',
  '.py': 'code',
  '.pyw': 'code',
  '.r': 'code',
  '.rb': 'code',
  '.rs': 'code',
  '.rst': 'markdown',
  '.s': 'code',
  '.sass': 'css',
  '.scala': 'code',
  '.scss': 'css',
  '.service': 'ini',
  '.sh': 'shell',
  '.sql': 'sql',
  '.svelte': 'markup',
  '.svg': 'markup',
  '.swift': 'code',
  '.tab': 'plain',
  '.tex': 'code',
  '.text': 'plain',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsv': 'plain',
  '.tsx': 'typescript',
  '.txt': 'plain',
  '.vcf': 'plain',
  '.vue': 'markup',
  '.xhtml': 'markup',
  '.xml': 'markup',
  '.xsd': 'markup',
  '.xsl': 'markup',
  '.xslt': 'markup',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.yarnrc': 'ini',
  '.zsh': 'shell',
}

const ExtensionlessLanguages: Record<string, TextPreviewLanguage> = {
  brewfile: 'code',
  cmakelists: 'code',
  'cmakelists.txt': 'code',
  dockerfile: 'code',
  gemfile: 'code',
  license: 'plain',
  makefile: 'code',
  procfile: 'code',
  readme: 'markdown',
  rakefile: 'code',
}

function normalizeMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';', 1)[0].trim().toLowerCase()
}

function normalizedBaseName(name: string | null | undefined): string {
  return (name ?? '').trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
}

function extensionFromFileName(name: string | null | undefined): string | undefined {
  const baseName = normalizedBaseName(name)
  const extensionStart = baseName.lastIndexOf('.')
  return extensionStart > 0 ? baseName.slice(extensionStart) : undefined
}

function hasCompatibleImageFileName(name: string | null | undefined, mimeType: string): boolean {
  const extension = extensionFromFileName(name)
  return extension === undefined || ImageExtensionsByMimeType[mimeType]?.has(extension) === true
}

function languageFromFileName(name: string | null | undefined): TextPreviewLanguage | undefined {
  const baseName = normalizedBaseName(name)
  if (!baseName) {
    return undefined
  }

  const exactMatch = ExtensionlessLanguages[baseName]
  if (exactMatch) {
    return exactMatch
  }

  for (const [extension, language] of Object.entries(ExtensionLanguages)) {
    if (baseName.endsWith(extension)) {
      return language
    }
  }

  return undefined
}

function languageFromMimeType(mimeType: string): TextPreviewLanguage | undefined {
  if (mimeType === 'application/json' || mimeType.endsWith('+json') || mimeType === 'application/x-ndjson') {
    return 'json'
  }
  if (
    mimeType === 'application/xml' ||
    mimeType === 'application/xhtml+xml' ||
    mimeType === 'image/svg+xml' ||
    (mimeType.startsWith('application/') && mimeType.endsWith('+xml')) ||
    mimeType === 'text/html' ||
    mimeType === 'text/xml'
  ) {
    return 'markup'
  }
  if (mimeType === 'application/x-openvpn-profile' || mimeType === 'application/openvpn-profile') {
    return 'openvpn'
  }
  if (mimeType === 'application/yaml' || mimeType === 'application/x-yaml' || mimeType === 'text/yaml') {
    return 'yaml'
  }
  if (mimeType === 'application/toml' || mimeType === 'application/x-toml') {
    return 'toml'
  }
  if (
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript' ||
    mimeType === 'text/javascript'
  ) {
    return 'javascript'
  }
  if (mimeType === 'text/css') {
    return 'css'
  }
  if (mimeType === 'application/sql') {
    return 'sql'
  }
  if (mimeType === 'application/x-sh' || mimeType === 'application/x-shellscript') {
    return 'shell'
  }
  if (mimeType === 'text/markdown' || mimeType === 'application/markdown') {
    return 'markdown'
  }
  if (mimeType.startsWith('text/') || StructuredTextFileTypes.has(mimeType)) {
    return 'plain'
  }
  if (mimeType.startsWith('application/') && (mimeType.endsWith('+json') || mimeType.endsWith('+xml'))) {
    return mimeType.endsWith('+json') ? 'json' : 'markup'
  }

  return undefined
}

/**
 * Resolves the only renderer that may receive decrypted file bytes. The result
 * is deliberately fail-closed: filename fallback is accepted only when the
 * server/browser supplied no useful MIME type, and unsupported files never
 * reach a generic embedded-object renderer.
 */
export function resolvePreviewKind(file: FilePreviewMetadata): FilePreviewKind {
  const mimeType = normalizeMimeType(file.mimeType)

  if (mimeType === 'application/pdf') {
    return 'pdf'
  }
  // SVG is markup, not an inert bitmap. Show its escaped source in the
  // read-only text viewer rather than handing active markup to a renderer.
  if (mimeType === 'image/svg+xml') {
    return 'text'
  }
  if (SupportedImageFileTypes.has(mimeType) && hasCompatibleImageFileName(file.name, mimeType)) {
    return 'image'
  }
  if (mimeType.startsWith('video/')) {
    return 'video'
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio'
  }
  if (languageFromMimeType(mimeType)) {
    return 'text'
  }
  // Opaque payloads get a bounded UTF-8 probe in the safe text viewer. The
  // decoder rejects NUL/control-heavy, malformed, and oversized content before
  // anything reaches the DOM, so extensionless logs/configs remain readable
  // without creating a generic executable/embed fallback for arbitrary MIME.
  if (OpaqueFileTypes.has(mimeType)) {
    return 'text'
  }

  return 'unsupported'
}

export function resolveTextPreviewLanguage(file: FilePreviewMetadata): TextPreviewLanguage {
  if (resolvePreviewKind(file) !== 'text') {
    return 'plain'
  }

  return languageFromFileName(file.name) ?? languageFromMimeType(normalizeMimeType(file.mimeType)) ?? 'plain'
}

export const isFilePreviewable = (file: FilePreviewMetadata): boolean => resolvePreviewKind(file) !== 'unsupported'

/**
 * Source URLs are never used to *infer* image status. A data URL is only used as
 * contradiction evidence: its declared payload MIME must match the trusted file
 * metadata before an inline node can take the image-body path.
 */
export function hasCompatibleInlineImageSource(file: FilePreviewMetadata, source: string): boolean {
  if (resolvePreviewKind(file) !== 'image') {
    return false
  }
  const normalizedSource = source.trimStart()
  if (!normalizedSource.toLowerCase().startsWith('data:')) {
    return true
  }

  const separator = normalizedSource.indexOf(',')
  if (separator === -1) {
    return false
  }
  const metadata = normalizedSource.slice(5, separator)
  const sourceMimeType = metadata.split(';', 1)[0]
  if (normalizeMimeType(sourceMimeType) !== normalizeMimeType(file.mimeType) || !/;base64(?:;|$)/i.test(metadata)) {
    return false
  }

  try {
    // Decode only a bounded prefix: enough for every supported signature, never
    // the potentially multi-megabyte data URL held by a legacy editor node.
    const encodedPrefix = normalizedSource.slice(separator + 1, separator + 65).replace(/\s/g, '')
    const binaryPrefix = atob(encodedPrefix)
    const bytes = Uint8Array.from(binaryPrefix, (character) => character.charCodeAt(0))
    return hasSupportedImageSignature(file, bytes)
  } catch {
    return false
  }
}

/** Byte signatures prevent a mislabeled PDF/text/binary payload reaching <img>. */
export function hasSupportedImageSignature(file: FilePreviewMetadata, bytes: Uint8Array): boolean {
  const mimeType = normalizeMimeType(file.mimeType)
  if (resolvePreviewKind(file) !== 'image') {
    return false
  }

  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, Math.min(bytes.byteLength, start + length)))
  switch (mimeType) {
    case 'image/png':
    case 'image/apng':
      return (
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        ascii(1, 3) === 'PNG' &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      )
    case 'image/jpeg':
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/gif':
      return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'
    case 'image/webp':
      return bytes.byteLength >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
    case 'image/bmp':
      return bytes.byteLength >= 2 && ascii(0, 2) === 'BM'
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return (
        bytes.byteLength >= 4 &&
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        (bytes[2] === 1 || bytes[2] === 2) &&
        bytes[3] === 0
      )
    case 'image/avif':
      return bytes.byteLength >= 12 && ascii(4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 4))
    default:
      return false
  }
}

/**
 * MIME-only compatibility helper. New call sites should pass the complete file
 * to `isFilePreviewable` so filenames can select the most useful text language.
 */
export const isFileTypePreviewable = (fileType: string): boolean => isFilePreviewable({ mimeType: fileType })
