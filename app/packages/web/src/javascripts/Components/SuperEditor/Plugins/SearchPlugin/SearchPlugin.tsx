import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApplication } from '../../../ApplicationProvider'
import {
  SUPER_TOGGLE_SEARCH,
  SUPER_SEARCH_TOGGLE_REPLACE_MODE,
  SUPER_SEARCH_TOGGLE_CASE_SENSITIVE,
  SUPER_SEARCH_NEXT_RESULT,
  SUPER_SEARCH_PREVIOUS_RESULT,
  KeyboardKey,
  keyboardStringForShortcut,
} from '@standardnotes/ui-services'
import { TranslateFromTopAnimation, TranslateToTopAnimation } from '../../../../Constants/AnimationConfigs'
import { useLifecycleAnimation } from '../../../../Hooks/useLifecycleAnimation'
import { classNames, debounce } from '@standardnotes/utils'
import DecoratedInput from '../../../Input/DecoratedInput'
import { searchInElement } from './searchInElement'
import { useKeyboardService } from '../../../KeyboardServiceProvider'
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, CloseIcon } from '@standardnotes/icons'
import Button from '../../../Button/Button'
import { canUseCSSHiglights, SearchHighlightRenderer, SearchHighlightRendererMethods } from './SearchHighlightRenderer'
import { useStateRef } from '../../../../Hooks/useStateRef'
import { createPortal } from 'react-dom'
import { $createRangeSelection, $getSelection, $nodesOfType, $setSelection, COMMAND_PRIORITY_LOW, TextNode } from 'lexical'
import {
  OPEN_SUPER_SEARCH_COMMAND,
  OPEN_SUPER_SEARCH_REPLACE_COMMAND,
  SUPER_SEARCH_GO_TO_NEXT_COMMAND,
} from './searchCommands'
import { compileSearch, computeReplacement, SearchOptions } from './replaceLogic'
import { searchRegexInElement } from './searchRegexInElement'
import { getMatchCounter, nextResultIndex, previousResultIndex } from './matchCounter'
import StyledTooltip from '../../../StyledTooltip/StyledTooltip'
import Icon from '../../../Icon/Icon'

export function SearchPlugin() {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()

  const [isSearchActive, setIsSearchActive] = useState(false)

  const [query, setQuery] = useState('')
  const queryRef = useStateRef(query)
  const [results, setResults] = useState<Range[]>([])

  const [isCaseSensitive, setIsCaseSensitive] = useState(false)
  const isCaseSensitiveRef = useStateRef(isCaseSensitive)
  const toggleCaseSensitivity = useCallback(() => setIsCaseSensitive((sensitive) => !sensitive), [])

  const [isWholeWord, setIsWholeWord] = useState(false)
  const isWholeWordRef = useStateRef(isWholeWord)
  const toggleWholeWord = useCallback(() => setIsWholeWord((enabled) => !enabled), [])

  const [isRegex, setIsRegex] = useState(false)
  const isRegexRef = useStateRef(isRegex)
  const toggleRegex = useCallback(() => setIsRegex((enabled) => !enabled), [])

  const [regexError, setRegexError] = useState<string | null>(null)

  const [isReplaceMode, setIsReplaceMode] = useState(false)
  const revealReplaceMode = useCallback(() => {
    setIsSearchActive(true)
    setIsReplaceMode(true)
  }, [])
  const toggleReplaceMode = useCallback(() => {
    setIsSearchActive(true)
    setIsReplaceMode((enabled) => !enabled)
  }, [])
  const [replaceQuery, setReplaceQuery] = useState('')

  const highlightRendererRef = useRef<SearchHighlightRendererMethods>(null)

  const [currentResultIndex, setCurrentResultIndex] = useState(-1)
  const highlightAndScrollResultIntoView = useCallback(
    (index: number) => {
      const result = results[index]
      if (!result) {
        return
      }
      const highlightRenderer = highlightRendererRef.current
      // Re-paint all matches while excluding the new active one so the distinct active
      // highlight isn't washed out by the all-matches highlight stacking on it. This also
      // restores the highlight on the previously-active match.
      highlightRenderer?.highlightMultipleRanges(results, result)
      highlightRenderer?.setActiveHighlight(result)
      result.startContainer.parentElement?.scrollIntoView({
        block: 'center',
      })
    },
    [results],
  )
  const goToNextResult = useCallback(() => {
    const next = nextResultIndex(currentResultIndex, results.length)
    if (next < 0) {
      return
    }
    highlightAndScrollResultIntoView(next)
    setCurrentResultIndex(next)
  }, [currentResultIndex, highlightAndScrollResultIntoView, results.length])
  const goToPrevResult = useCallback(() => {
    const prev = previousResultIndex(currentResultIndex, results.length)
    if (prev < 0) {
      return
    }
    highlightAndScrollResultIntoView(prev)
    setCurrentResultIndex(prev)
  }, [currentResultIndex, highlightAndScrollResultIntoView, results.length])

  const selectCurrentResult = useCallback(() => {
    if (results.length === 0) {
      return
    }
    const result = results[currentResultIndex]
    if (!result) {
      return
    }
    editor.update(() => {
      const rangeSelection = $createRangeSelection()
      rangeSelection.applyDOMRange(result)
      $setSelection(rangeSelection)
    })
  }, [currentResultIndex, editor, results])

  const [shouldHighlightAll, setShouldHighlightAll] = useState(canUseCSSHiglights)

  const closeDialog = useCallback(() => {
    selectCurrentResult()
    setIsSearchActive(false)
    setQuery('')
    setResults([])
    setIsCaseSensitive(false)
    setIsWholeWord(false)
    setIsRegex(false)
    setRegexError(null)
    setIsReplaceMode(false)
    setReplaceQuery('')
    setShouldHighlightAll(canUseCSSHiglights)
    editor.update(() => {
      if ($getSelection() !== null) {
        editor.focus()
      }
    })
  }, [editor, selectCurrentResult])

  // Non-toggling toolbar entry points (the "Selection" group). These OPEN the
  // panel rather than flipping it, so a second click keeps it open.
  useEffect(() => {
    const unregister = [
      editor.registerCommand(
        OPEN_SUPER_SEARCH_COMMAND,
        () => {
          setIsSearchActive(true)
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        OPEN_SUPER_SEARCH_REPLACE_COMMAND,
        () => {
          revealReplaceMode()
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        SUPER_SEARCH_GO_TO_NEXT_COMMAND,
        () => {
          goToNextResult()
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
    ]
    return () => unregister.forEach((cleanup) => cleanup())
  }, [editor, revealReplaceMode, goToNextResult])

  useEffect(() => {
    return application.keyboardService.addCommandHandlers([
      {
        command: SUPER_TOGGLE_SEARCH,
        category: 'Super notes',
        description: 'Search in current note',
        onKeyDown: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsSearchActive((active) => !active)
        },
      },
      {
        command: SUPER_SEARCH_TOGGLE_REPLACE_MODE,
        category: 'Super notes',
        description: 'Search and replace in current note',
        onKeyDown: (event) => {
          if (!editor.isEditable()) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          revealReplaceMode()
        },
      },
      {
        command: SUPER_SEARCH_TOGGLE_CASE_SENSITIVE,
        onKeyDown() {
          toggleCaseSensitivity()
        },
      },
      {
        command: SUPER_SEARCH_NEXT_RESULT,
        category: 'Super notes',
        description: 'Go to next search result',
        onKeyDown(event) {
          event.preventDefault()
          event.stopPropagation()
          goToNextResult()
        },
      },
      {
        command: SUPER_SEARCH_PREVIOUS_RESULT,
        category: 'Super notes',
        description: 'Go to previous search result',
        onKeyDown(event) {
          event.preventDefault()
          event.stopPropagation()
          goToPrevResult()
        },
      },
    ])
  }, [application.keyboardService, editor, goToNextResult, goToPrevResult, toggleCaseSensitivity, revealReplaceMode])

  const searchQueryAndHighlight = useCallback(
    (query: string, options: SearchOptions) => {
      const highlightRenderer = highlightRendererRef.current
      const rootElement = editor.getRootElement()
      highlightRenderer?.clearHighlights()

      if (!rootElement || !query) {
        setResults([])
        setCurrentResultIndex(-1)
        setRegexError(null)
        return
      }

      let ranges: Range[] = []
      if (options.isRegex || options.isWholeWord) {
        const compiled = compileSearch(query, options, true)
        if (compiled.error) {
          setRegexError(compiled.error)
          setResults([])
          setCurrentResultIndex(-1)
          return
        }
        setRegexError(null)
        if (compiled.regex) {
          ranges = searchRegexInElement(rootElement, compiled.regex)
        }
      } else {
        setRegexError(null)
        // Literal, non-whole-word search keeps the cross-node-capable implementation.
        ranges = searchInElement(rootElement, query, options.isCaseSensitive)
      }

      setResults(ranges)
      if (ranges.length > 0) {
        setCurrentResultIndex(0)
        highlightRenderer?.highlightMultipleRanges(ranges, ranges[0])
        highlightRenderer?.setActiveHighlight(ranges[0])
      } else {
        highlightRenderer?.highlightMultipleRanges(ranges)
        setCurrentResultIndex(-1)
      }
    },
    [editor],
  )

  const handleQueryChange = useMemo(() => debounce(searchQueryAndHighlight, 30), [searchQueryAndHighlight])
  const handleEditorChange = useMemo(() => debounce(searchQueryAndHighlight, 250), [searchQueryAndHighlight])

  useEffect(() => {
    void handleQueryChange(query, { isCaseSensitive, isWholeWord, isRegex })
  }, [handleQueryChange, isCaseSensitive, isRegex, isWholeWord, query])

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, prevEditorState, tags }) => {
      if (
        (dirtyElements.size === 0 && dirtyLeaves.size === 0) ||
        tags.has('history-merge') ||
        prevEditorState.isEmpty()
      ) {
        return
      }

      void handleEditorChange(queryRef.current, {
        isCaseSensitive: isCaseSensitiveRef.current,
        isWholeWord: isWholeWordRef.current,
        isRegex: isRegexRef.current,
      })
    })
  }, [editor, handleEditorChange, isCaseSensitiveRef, isRegexRef, isWholeWordRef, queryRef])

  const currentOptions = useCallback(
    (): SearchOptions => ({ isCaseSensitive, isWholeWord, isRegex }),
    [isCaseSensitive, isRegex, isWholeWord],
  )

  /**
   * Performs the replacement over the editor's text nodes inside a single editor.update()
   * (one undoable step). When `replaceAll` is false only the first matching text node is
   * mutated (its first match), otherwise all matches in all text nodes are replaced.
   *
   * Note: matches are computed per individual TextNode, so a match that spans multiple
   * text nodes (across formatting boundaries) is not replaced. This mirrors the regex
   * highlight limitation and is a documented best-effort behavior.
   */
  const runReplace = useCallback(
    (replaceAll: boolean) => {
      const options = currentOptions()
      const compiled = compileSearch(query, options, replaceAll)
      if (compiled.error) {
        setRegexError(compiled.error)
        return
      }
      if (!compiled.regex || !query) {
        return
      }

      let didReplace = false
      editor.update(
        () => {
          const textNodes = $nodesOfType(TextNode)
          for (const node of textNodes) {
            const text = node.getTextContent()
            const { output, count } = computeReplacement(text, query, replaceQuery, options, replaceAll)
            if (count > 0 && output !== text) {
              node.setTextContent(output)
              didReplace = true
              if (!replaceAll) {
                break
              }
            }
          }
        },
        {
          tag: 'skip-dom-selection',
        },
      )

      if (didReplace) {
        searchQueryAndHighlight(query, options)
      }
    },
    [currentOptions, editor, query, replaceQuery, searchQueryAndHighlight],
  )

  const replaceCurrentResult = useCallback(() => runReplace(false), [runReplace])
  const replaceAllResults = useCallback(() => runReplace(true), [runReplace])

  const [isMounted, setElement] = useLifecycleAnimation({
    open: isSearchActive,
    enter: TranslateFromTopAnimation,
    exit: TranslateToTopAnimation,
  })

  const focusOnMount = useCallback((node: HTMLInputElement | null) => {
    if (node) {
      node.focus()
    }
  }, [])

  const keyboardService = useKeyboardService()
  const searchToggleShortcut = useMemo(
    () => keyboardStringForShortcut(keyboardService.keyboardShortcutForCommand(SUPER_TOGGLE_SEARCH)),
    [keyboardService],
  )
  const toggleReplaceShortcut = useMemo(
    () => keyboardStringForShortcut(keyboardService.keyboardShortcutForCommand(SUPER_SEARCH_TOGGLE_REPLACE_MODE)),
    [keyboardService],
  )
  const caseSensitivityShortcut = useMemo(
    () => keyboardStringForShortcut(keyboardService.keyboardShortcutForCommand(SUPER_SEARCH_TOGGLE_CASE_SENSITIVE)),
    [keyboardService],
  )

  if (!isMounted) {
    return null
  }

  return (
    <>
      <div
        className={classNames(
          'absolute left-2 right-6 top-2 z-10 flex select-none rounded border border-border bg-default font-sans md:left-auto',
          editor.isEditable() ? 'md:top-13' : 'md:top-3',
        )}
        ref={setElement}
      >
        {editor.isEditable() && (
          <button
            className="focus:ring-none border-r border-border px-1 hover:bg-contrast focus:shadow-inner focus:shadow-info"
            onClick={toggleReplaceMode}
            title={`Toggle Replace Mode (${toggleReplaceShortcut})`}
          >
            {isReplaceMode ? (
              <ArrowDownIcon className="h-4 w-4 fill-text" />
            ) : (
              <ArrowRightIcon className="h-4 w-4 fill-text" />
            )}
          </button>
        )}
        <div
          className="flex flex-col gap-2 px-2 py-2"
          onKeyDown={(event) => {
            if (event.key === KeyboardKey.Escape) {
              closeDialog()
            }
          }}
        >
          <div className="flex items-center gap-2">
            <DecoratedInput
              placeholder="Search"
              className={{
                container: classNames('flex-grow !text-[length:inherit]', !query.length && '!py-1'),
                right: '!py-1',
              }}
              value={query}
              onChange={setQuery}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && results.length) {
                  if (event.shiftKey) {
                    goToPrevResult()
                    return
                  }
                  goToNextResult()
                }
              }}
              ref={focusOnMount}
              right={[
                <div className="min-w-[7ch] max-w-[7ch] flex-shrink-0 whitespace-nowrap text-right">
                  {query.length > 0 && getMatchCounter(currentResultIndex, results.length).label}
                </div>,
              ]}
            />
            <label
              className={classNames(
                'relative flex items-center rounded border px-1.5 py-1 focus-within:ring-2 focus-within:ring-info focus-within:ring-offset-2 focus-within:ring-offset-default',
                isCaseSensitive ? 'border-info bg-info text-info-contrast' : 'border-border hover:bg-contrast',
              )}
              title={`Case sensitive (${caseSensitivityShortcut})`}
            >
              <input
                type="checkbox"
                className="absolute left-0 top-0 z-[1] m-0 h-full w-full cursor-pointer border border-transparent p-0 opacity-0 shadow-none outline-none"
                checked={isCaseSensitive}
                onChange={toggleCaseSensitivity}
              />
              <span aria-hidden>Aa</span>
              <span className="sr-only">Case sensitive</span>
            </label>
            <label
              className={classNames(
                'relative flex items-center rounded border px-1.5 py-1 focus-within:ring-2 focus-within:ring-info focus-within:ring-offset-2 focus-within:ring-offset-default',
                isWholeWord ? 'border-info bg-info text-info-contrast' : 'border-border hover:bg-contrast',
              )}
              title="Whole word"
            >
              <input
                type="checkbox"
                className="absolute left-0 top-0 z-[1] m-0 h-full w-full cursor-pointer border border-transparent p-0 opacity-0 shadow-none outline-none"
                checked={isWholeWord}
                onChange={toggleWholeWord}
              />
              <span aria-hidden>ab</span>
              <span className="sr-only">Whole word</span>
            </label>
            <label
              className={classNames(
                'relative flex items-center rounded border px-1.5 py-1 focus-within:ring-2 focus-within:ring-info focus-within:ring-offset-2 focus-within:ring-offset-default',
                isRegex ? 'border-info bg-info text-info-contrast' : 'border-border hover:bg-contrast',
              )}
              title="Use regular expression"
            >
              <input
                type="checkbox"
                className="absolute left-0 top-0 z-[1] m-0 h-full w-full cursor-pointer border border-transparent p-0 opacity-0 shadow-none outline-none"
                checked={isRegex}
                onChange={toggleRegex}
              />
              <span aria-hidden>.*</span>
              <span className="sr-only">Use regular expression</span>
            </label>
            <button
              className="flex items-center rounded border border-border p-1.5 hover:bg-contrast disabled:cursor-not-allowed"
              onClick={goToPrevResult}
              disabled={results.length < 1}
              title="Previous result (Shift + Enter)"
            >
              <ArrowUpIcon className="h-4 w-4 fill-current text-text" />
            </button>
            <button
              className="flex items-center rounded border border-border p-1.5 hover:bg-contrast disabled:cursor-not-allowed"
              onClick={goToNextResult}
              disabled={results.length < 1}
              title="Next result (Enter)"
            >
              <ArrowDownIcon className="h-4 w-4 fill-current text-text" />
            </button>
            <button
              className="flex items-center rounded border border-border p-1.5 hover:bg-contrast"
              onClick={() => {
                closeDialog()
              }}
              title={`Close (${searchToggleShortcut})`}
            >
              <CloseIcon className="h-4 w-4 fill-current text-text" />
            </button>
          </div>
          {regexError && (
            <div className="text-sm text-danger" role="alert">
              {regexError}
            </div>
          )}
          {isReplaceMode && (
            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
              <input
                type="text"
                placeholder="Replace"
                value={replaceQuery}
                onChange={(e) => {
                  setReplaceQuery(e.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && results.length) {
                    if (event.ctrlKey && event.altKey) {
                      replaceAllResults()
                      event.preventDefault()
                      return
                    }
                    replaceCurrentResult()
                    event.preventDefault()
                  }
                }}
                className="rounded border border-border bg-default p-1 px-2"
                ref={focusOnMount}
              />
              <Button
                small
                onClick={replaceCurrentResult}
                disabled={results.length < 1}
                title="Replace (Ctrl + Enter)"
              >
                Replace
              </Button>
              <Button
                small
                onClick={replaceAllResults}
                disabled={results.length < 1}
                title="Replace all (Ctrl + Alt + Enter)"
              >
                Replace all
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2">
              <input
                className="h-4 w-4 rounded accent-info"
                type="checkbox"
                checked={shouldHighlightAll}
                onChange={(e) => setShouldHighlightAll(e.target.checked)}
              />
              <div>Highlight all results</div>
            </label>
            {!canUseCSSHiglights && (
              <StyledTooltip
                label="May lead to performance degradation, especially on large documents."
                className="!z-modal"
                showOnMobile
              >
                <button className="cursor-default">
                  <Icon type="info" size="medium" />
                </button>
              </StyledTooltip>
            )}
          </div>
        </div>
      </div>
      {createPortal(
        <SearchHighlightRenderer shouldHighlightAll={shouldHighlightAll} ref={highlightRendererRef} />,
        editor.getRootElement()?.parentElement || document.body,
      )}
    </>
  )
}
