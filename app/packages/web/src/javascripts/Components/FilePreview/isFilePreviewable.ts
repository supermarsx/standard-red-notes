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
  if (mimeType.startsWith('image/')) {
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
  if (OpaqueFileTypes.has(mimeType) && languageFromFileName(file.name)) {
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
 * MIME-only compatibility helper. New call sites should pass the complete file
 * to `isFilePreviewable` so safe filename fallback (for example `.ovpn` files
 * reported as application/octet-stream) can be applied.
 */
export const isFileTypePreviewable = (fileType: string): boolean => isFilePreviewable({ mimeType: fileType })
