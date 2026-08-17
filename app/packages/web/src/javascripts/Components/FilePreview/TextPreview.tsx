import { ElementIds } from '@/Constants/ElementIDs'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveTextPreviewLanguage, TextPreviewLanguage } from './isFilePreviewable'
import {
  canUseSyntaxHighlighting,
  decodeTextPreview,
  HighlightTokenKind,
  neutralizeBidiControls,
  tokenizeText,
} from './textPreviewContent'

type Props = {
  bytes: Uint8Array
  fileName: string
  mimeType: string
}

const LanguageNames: Record<TextPreviewLanguage, string> = {
  plain: 'Plain text',
  openvpn: 'OpenVPN',
  json: 'JSON',
  markup: 'Markup',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'Configuration',
  markdown: 'Markdown',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  css: 'CSS',
  shell: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  diff: 'Diff',
  code: 'Source code',
}

const TokenClasses: Record<HighlightTokenKind, string> = {
  plain: 'text-text',
  comment: 'text-passive-0 italic',
  keyword: 'text-info font-semibold',
  string: 'text-success',
  number: 'text-warning',
  property: 'text-info',
  operator: 'text-passive-0',
  tag: 'text-danger',
  addition: 'text-success',
  deletion: 'text-danger',
}

const TextPreview = ({ bytes, fileName, mimeType }: Props) => {
  const { t } = useTranslation('files')
  const [wrapLines, setWrapLines] = useState(true)
  const [highlightSyntax, setHighlightSyntax] = useState(true)
  const decoded = useMemo(() => decodeTextPreview(bytes), [bytes])
  const safeFileName = useMemo(() => neutralizeBidiControls(fileName), [fileName])
  const displayFileName = safeFileName.text || t('textPreviewUntitled')
  const language = useMemo(() => resolveTextPreviewLanguage({ name: fileName, mimeType }), [fileName, mimeType])
  const highlightingAvailable =
    decoded.status === 'ready' && canUseSyntaxHighlighting(bytes.byteLength, decoded.text, language)
  const showHighlighted = decoded.status === 'ready' && highlightSyntax && highlightingAvailable
  const highlightedLines = useMemo(
    () => (showHighlighted && decoded.status === 'ready' ? tokenizeText(decoded.text, language) : []),
    [decoded, language, showHighlighted],
  )

  if (decoded.status !== 'ready') {
    return (
      <div className="flex h-full w-full flex-grow items-center justify-center p-6" role="alert">
        <div className="max-w-[42ch] text-center">
          <div className="text-base font-bold">{t('textPreviewUnavailable')}</div>
          <p className="text-passive-0 mt-2 text-sm">
            {decoded.status === 'too-large' ? t('textPreviewTooLarge') : t('textPreviewInvalidText')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="border-border bg-default flex h-full min-h-0 w-full flex-grow flex-col overflow-hidden rounded border">
      <div className="border-border bg-contrast flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2" dir="ltr">
          <span className="max-w-[32ch] truncate text-sm font-semibold" title={displayFileName}>
            {displayFileName}
          </span>
          <span className="text-passive-0 text-xs">{LanguageNames[language]}</span>
        </div>
        <div className="flex items-center gap-1" role="toolbar" aria-label={t('textPreviewControls')}>
          {language !== 'plain' && (
            <button
              aria-pressed={showHighlighted}
              className="hover:bg-default focus-visible:ring-info rounded px-2 py-1 text-xs font-semibold focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!highlightingAvailable}
              onClick={() => setHighlightSyntax((enabled) => !enabled)}
              title={!highlightingAvailable ? t('textPreviewHighlightingLimited') : undefined}
              type="button"
            >
              {t('textPreviewSyntax')}
            </button>
          )}
          <button
            aria-pressed={wrapLines}
            className="hover:bg-default focus-visible:ring-info rounded px-2 py-1 text-xs font-semibold focus:outline-none focus-visible:ring-2"
            onClick={() => setWrapLines((enabled) => !enabled)}
            type="button"
          >
            {t('textPreviewWrap')}
          </button>
        </div>
      </div>

      {(decoded.hadBidiControls || safeFileName.hadBidiControls) && (
        <div className="border-border bg-warning/10 text-warning border-b px-3 py-1.5 text-xs" role="status">
          {t('textPreviewBidiControlsNeutralized')}
        </div>
      )}

      {showHighlighted ? (
        <div
          aria-label={t('textPreviewReadOnly', { fileName: displayFileName })}
          aria-readonly="true"
          className="font-editor min-h-0 flex-grow overflow-auto py-3 text-sm"
          dir="ltr"
          id={ElementIds.FileTextPreview}
          role="textbox"
          tabIndex={0}
        >
          <ol className="marker:text-passive-0 m-0 min-w-full list-decimal pl-12">
            {highlightedLines.map((tokens, lineIndex) => (
              <li className="hover:border-info hover:bg-contrast border-l border-transparent px-3" key={lineIndex}>
                <code className={wrapLines ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'}>
                  {tokens.length === 0
                    ? '\u200b'
                    : tokens.map((token, tokenIndex) => (
                        <span className={TokenClasses[token.kind]} data-token-kind={token.kind} key={tokenIndex}>
                          {token.text}
                        </span>
                      ))}
                </code>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <textarea
          aria-label={t('textPreviewReadOnly', { fileName: displayFileName })}
          autoComplete="off"
          className={`font-editor bg-default text-text min-h-0 w-full flex-grow resize-none overflow-auto px-4 py-3 text-sm focus:shadow-none focus:outline-none ${
            wrapLines ? 'whitespace-pre-wrap' : 'whitespace-pre'
          }`}
          dir="ltr"
          id={ElementIds.FileTextPreview}
          readOnly={true}
          spellCheck={false}
          value={decoded.text}
          wrap={wrapLines ? 'soft' : 'off'}
        />
      )}
    </div>
  )
}

export default TextPreview
