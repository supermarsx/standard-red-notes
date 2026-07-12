/**
 * Hook wrapper for the Insert -> Symbol picker. Bridges the pure
 * SymbolPickerGrid to the editor + i18n: owns the search query and the
 * recently-used state, inserts the chosen char as plain text at the caret, and
 * keeps the modal open for multi-insert (the Modal chrome supplies Esc / X /
 * click-outside to close).
 *
 * Rendered via `showModal(...)` from BOTH insert surfaces (slash picker +
 * toolbar), exactly like InsertRemoteImageDialog — a proven hook-based,
 * dual-surface dialog.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SymbolPickerGrid from './SymbolPickerGrid'
import { filterSymbols } from './symbolCatalog'
import { $insertSymbol, addRecentSymbol, loadRecentSymbols, saveRecentSymbols } from './insertSymbol'

export type SymbolPickerDialogProps = {
  /** Supplied by the modal host; unused for now — the Modal chrome already closes on Esc / X / click-outside. */
  onClose: () => void
}

export default function SymbolPickerDialog(_props: SymbolPickerDialogProps) {
  const { t } = useTranslation('editor')
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>(() => loadRecentSymbols())

  const categories = useMemo(() => filterSymbols(query), [query])

  const handleInsert = (char: string) => {
    editor.update(() => $insertSymbol(char))
    setRecents((prev) => {
      const next = addRecentSymbol(prev, char)
      saveRecentSymbols(next)
      return next
    })
    // Deliberately does NOT call onClose — keep-open multi-insert; the user
    // closes via the Modal's Esc / X / click-outside.
  }

  return (
    <SymbolPickerGrid
      query={query}
      onQueryChange={setQuery}
      categories={categories}
      recents={recents}
      onInsert={handleInsert}
      labels={{
        search: t('searchSymbols'),
        recents: t('recentSymbols'),
        noResults: t('noSymbolsFound'),
      }}
    />
  )
}
