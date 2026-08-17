import { TextPreviewLanguage } from './isFilePreviewable'

/** Keep decoding and DOM construction bounded even if an untrusted file slips past an outer size check. */
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_HIGHLIGHT_BYTES = 256 * 1024
export const MAX_HIGHLIGHT_LINES = 4_000

export type TextPreviewDecodeResult =
  | { status: 'ready'; text: string; hadBidiControls: boolean }
  | { status: 'too-large' }
  | { status: 'binary-or-invalid-utf8' }

export type HighlightTokenKind =
  'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'property' | 'operator' | 'tag' | 'addition' | 'deletion'

export type HighlightToken = {
  kind: HighlightTokenKind
  text: string
}

const CommonKeywords = new Set(
  [
    'as',
    'async',
    'await',
    'begin',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'create',
    'default',
    'delete',
    'do',
    'drop',
    'else',
    'end',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'insert',
    'interface',
    'into',
    'let',
    'new',
    'null',
    'of',
    'return',
    'select',
    'static',
    'switch',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'update',
    'using',
    'var',
    'void',
    'where',
    'while',
    'with',
    'yield',
  ].map((keyword) => keyword.toLowerCase()),
)

const BidiControlNames = new Map<string, string>([
  ['\u061c', 'U+061C ARABIC LETTER MARK'],
  ['\u200e', 'U+200E LEFT-TO-RIGHT MARK'],
  ['\u200f', 'U+200F RIGHT-TO-LEFT MARK'],
  ['\u202a', 'U+202A LEFT-TO-RIGHT EMBEDDING'],
  ['\u202b', 'U+202B RIGHT-TO-LEFT EMBEDDING'],
  ['\u202c', 'U+202C POP DIRECTIONAL FORMATTING'],
  ['\u202d', 'U+202D LEFT-TO-RIGHT OVERRIDE'],
  ['\u202e', 'U+202E RIGHT-TO-LEFT OVERRIDE'],
  ['\u2066', 'U+2066 LEFT-TO-RIGHT ISOLATE'],
  ['\u2067', 'U+2067 RIGHT-TO-LEFT ISOLATE'],
  ['\u2068', 'U+2068 FIRST STRONG ISOLATE'],
  ['\u2069', 'U+2069 POP DIRECTIONAL ISOLATE'],
])

function pushToken(tokens: HighlightToken[], kind: HighlightTokenKind, text: string): void {
  if (!text) {
    return
  }

  const previous = tokens.at(-1)
  if (previous?.kind === kind) {
    previous.text += text
  } else {
    tokens.push({ kind, text })
  }
}

function isAllowedTextControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d
}

function looksBinary(text: string): boolean {
  let suspiciousControls = 0
  const maximumControls = Math.max(2, Math.floor(text.length * 0.01))

  for (let index = 0; index < text.length; index++) {
    const codePoint = text.charCodeAt(index)
    if (codePoint === 0) {
      return true
    }
    if (codePoint === 0x7f || (codePoint < 0x20 && !isAllowedTextControl(codePoint))) {
      suspiciousControls++
      if (suspiciousControls > maximumControls) {
        return true
      }
    }
  }

  return false
}

export function neutralizeBidiControls(value: string): { text: string; hadBidiControls: boolean } {
  let text = ''
  let hadBidiControls = false

  for (const character of value) {
    const controlName = BidiControlNames.get(character)
    if (controlName) {
      hadBidiControls = true
      text += `[${controlName}]`
    } else {
      text += character
    }
  }

  return { text, hadBidiControls }
}

export function decodeTextPreview(bytes: Uint8Array): TextPreviewDecodeResult {
  if (bytes.byteLength > MAX_TEXT_PREVIEW_BYTES) {
    return { status: 'too-large' }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (looksBinary(text)) {
      return { status: 'binary-or-invalid-utf8' }
    }
    const neutralized = neutralizeBidiControls(text)
    return { status: 'ready', text: neutralized.text, hadBidiControls: neutralized.hadBidiControls }
  } catch {
    return { status: 'binary-or-invalid-utf8' }
  }
}

function lineCountExceeds(text: string, maximum: number): boolean {
  let lines = 1
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 0x0a) {
      lines++
      if (lines > maximum) {
        return true
      }
    }
  }
  return false
}

export function canUseSyntaxHighlighting(byteLength: number, text: string, language: TextPreviewLanguage): boolean {
  return language !== 'plain' && byteLength <= MAX_HIGHLIGHT_BYTES && !lineCountExceeds(text, MAX_HIGHLIGHT_LINES)
}

function commentPrefixes(language: TextPreviewLanguage): string[] {
  switch (language) {
    case 'shell':
    case 'powershell':
    case 'yaml':
      return ['#']
    case 'ini':
    case 'toml':
      return ['#', ';']
    case 'sql':
      return ['--']
    case 'javascript':
    case 'typescript':
    case 'css':
    case 'code':
      return ['//', '/*']
    default:
      return []
  }
}

function startsWithAny(text: string, index: number, candidates: string[]): string | undefined {
  return candidates.find((candidate) => text.startsWith(candidate, index))
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character)
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$-]/.test(character)
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

function nextNonWhitespaceIndex(line: string, start: number): number {
  let index = start
  while (index < line.length && /\s/.test(line[index])) {
    index++
  }
  return index
}

function tokenizeGenericLine(line: string, language: TextPreviewLanguage, startAt = 0): HighlightToken[] {
  const tokens: HighlightToken[] = []
  const comments = commentPrefixes(language)
  let index = startAt

  if (startAt > 0) {
    pushToken(tokens, 'plain', line.slice(0, startAt))
  }

  while (index < line.length) {
    const commentPrefix = startsWithAny(line, index, comments)
    if (commentPrefix) {
      pushToken(tokens, 'comment', line.slice(index))
      break
    }

    const character = line[index]
    if (character === '"' || character === "'" || character === '`') {
      const quote = character
      let end = index + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end = Math.min(line.length, end + 2)
          continue
        }
        if (line[end] === quote) {
          end++
          break
        }
        end++
      }
      const next = nextNonWhitespaceIndex(line, end)
      const isProperty = language === 'json' && line[next] === ':'
      pushToken(tokens, isProperty ? 'property' : 'string', line.slice(index, end))
      index = end
      continue
    }

    if (isDigit(character) || (character === '-' && isDigit(line[index + 1] ?? ''))) {
      let end = index + 1
      while (end < line.length && /[0-9A-Fa-f_xX.eE+-]/.test(line[end])) {
        end++
      }
      pushToken(tokens, 'number', line.slice(index, end))
      index = end
      continue
    }

    if (isIdentifierStart(character)) {
      let end = index + 1
      while (end < line.length && isIdentifierPart(line[end])) {
        end++
      }
      const word = line.slice(index, end)
      const next = nextNonWhitespaceIndex(line, end)
      const isProperty =
        (language === 'yaml' || language === 'toml' || language === 'ini') && /[:=]/.test(line[next] ?? '')
      const isKeyword = CommonKeywords.has(word.toLowerCase())
      pushToken(tokens, isProperty ? 'property' : isKeyword ? 'keyword' : 'plain', word)
      index = end
      continue
    }

    if ('{}[]():,;=<>+-*/!&|.%@'.includes(character)) {
      pushToken(tokens, 'operator', character)
    } else {
      pushToken(tokens, 'plain', character)
    }
    index++
  }

  return tokens
}

function tokenizeOpenVpnLine(line: string): HighlightToken[] {
  const firstContent = nextNonWhitespaceIndex(line, 0)
  const content = line.slice(firstContent)
  if (!content) {
    return [{ kind: 'plain', text: line }]
  }
  if (content.startsWith('#') || content.startsWith(';')) {
    const tokens: HighlightToken[] = []
    pushToken(tokens, 'plain', line.slice(0, firstContent))
    pushToken(tokens, 'comment', content)
    return tokens
  }
  if (/^<\/?[A-Za-z][^>]*>$/.test(content)) {
    const tokens: HighlightToken[] = []
    pushToken(tokens, 'plain', line.slice(0, firstContent))
    pushToken(tokens, 'tag', content)
    return tokens
  }

  let directiveEnd = firstContent
  while (directiveEnd < line.length && isIdentifierPart(line[directiveEnd])) {
    directiveEnd++
  }
  const tokens: HighlightToken[] = []
  pushToken(tokens, 'plain', line.slice(0, firstContent))
  pushToken(tokens, 'keyword', line.slice(firstContent, directiveEnd))
  tokens.push(...tokenizeGenericLine(line.slice(directiveEnd), 'plain'))
  return tokens
}

function tokenizeMarkupLine(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let index = 0
  while (index < line.length) {
    const opening = line.indexOf('<', index)
    if (opening === -1) {
      pushToken(tokens, 'plain', line.slice(index))
      break
    }
    pushToken(tokens, 'plain', line.slice(index, opening))
    if (line.startsWith('<!--', opening)) {
      const closing = line.indexOf('-->', opening + 4)
      const end = closing === -1 ? line.length : closing + 3
      pushToken(tokens, 'comment', line.slice(opening, end))
      index = end
      continue
    }
    const closing = line.indexOf('>', opening + 1)
    const end = closing === -1 ? line.length : closing + 1
    pushToken(tokens, 'tag', line.slice(opening, end))
    index = end
  }
  return tokens
}

function tokenizeMarkdownLine(line: string): HighlightToken[] {
  const marker = line.match(/^(\s{0,3})(#{1,6}\s+|>\s*|[-*+]\s+)/)
  if (!marker) {
    return tokenizeGenericLine(line, 'plain')
  }

  const tokens: HighlightToken[] = []
  pushToken(tokens, 'plain', marker[1])
  pushToken(tokens, 'keyword', marker[2])
  tokens.push(...tokenizeGenericLine(line.slice(marker[0].length), 'plain'))
  return tokens
}

export function tokenizeTextLine(line: string, language: TextPreviewLanguage): HighlightToken[] {
  if (language === 'openvpn') {
    return tokenizeOpenVpnLine(line)
  }
  if (language === 'markup') {
    return tokenizeMarkupLine(line)
  }
  if (language === 'markdown') {
    return tokenizeMarkdownLine(line)
  }
  if (language === 'diff') {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return [{ kind: 'keyword', text: line }]
    }
    if (line.startsWith('+')) {
      return [{ kind: 'addition', text: line }]
    }
    if (line.startsWith('-')) {
      return [{ kind: 'deletion', text: line }]
    }
  }
  return tokenizeGenericLine(line, language)
}

export function tokenizeText(text: string, language: TextPreviewLanguage): HighlightToken[][] {
  return text.split(/\r\n|\r|\n/).map((line) => tokenizeTextLine(line, language))
}
