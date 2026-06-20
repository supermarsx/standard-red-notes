import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useRef, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import { getContextualSearchAvailability, runContextualRerank } from '@/Assistant/contextualSearch'
import { isContextualSearchEnabled } from '@/Assistant/contextualSearchSettings'
import Icon from '../Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'

type Props = {
  application: WebApplication
  itemListController: ItemListController
}

/**
 * "Search with AI" action for the search bar. Only rendered when the web-local AI
 * contextual-search toggle is ON (default OFF). It re-ranks the TOP-N algorithmic
 * candidates by semantic relevance using the configured assistant provider — a
 * single, submit-triggered model call (never fired on keystroke). Degrades to a
 * disabled button with an explanatory tooltip when no provider is configured.
 */
const AiContextualSearch = ({ application, itemListController }: Props) => {
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<AbortController | null>(null)

  // Off by default — when disabled the whole action is absent and search is the
  // unchanged algorithmic behavior.
  const enabled = isContextualSearchEnabled()

  const availability = useMemo(
    () => getContextualSearchAvailability(application),
    // Re-evaluate when the query changes so a freshly-configured provider unlocks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application, itemListController.noteFilterText],
  )

  const query = itemListController.aiRerankQuery
  const hasQuery = query.trim().length > 0
  const isActive =
    itemListController.aiContextualOrder !== null && itemListController.aiContextualQuery === query

  const runAiSearch = useCallback(async () => {
    setError(null)
    const currentQuery = itemListController.aiRerankQuery
    if (currentQuery.trim().length === 0) {
      return
    }

    // Cancel any previous in-flight re-rank so rapid clicks don't pile up.
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller

    const candidates = itemListController.getAiRerankCandidates()
    itemListController.setAiContextualLoading(true)
    try {
      const orderedUuids = await runContextualRerank(application, currentQuery, candidates, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        return
      }
      if (orderedUuids) {
        itemListController.setAiContextualOrder(currentQuery, orderedUuids)
      } else {
        setError('AI re-ranking is unavailable or returned no result.')
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null
      }
      itemListController.setAiContextualLoading(false)
    }
  }, [application, itemListController])

  if (!enabled) {
    return null
  }

  const disabled = !availability.available || !hasQuery || itemListController.aiContextualLoading
  const tooltip = !availability.available
    ? availability.reason || 'AI contextual search is unavailable.'
    : !hasQuery
      ? 'Type a search query first.'
      : 'Re-rank the top results by semantic relevance using your configured AI provider. ' +
        'Sends those candidates’ titles and short snippets, plus your query, to the provider.'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <StyledTooltip label={tooltip} showOnHover>
          <button
            role="button"
            aria-label="Search with AI"
            aria-pressed={isActive}
            disabled={disabled}
            className={
              'flex items-center gap-1 rounded-full border px-2 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ' +
              (isActive
                ? 'border-info bg-info text-info-contrast'
                : 'border-border text-neutral hover:bg-contrast')
            }
            onClick={() => void runAiSearch()}
          >
            <Icon type={itemListController.aiContextualLoading ? 'restore' : 'dashboard'} size="small" />
            <span>{itemListController.aiContextualLoading ? 'Ranking…' : 'Search with AI'}</span>
          </button>
        </StyledTooltip>
        {isActive && <span className="text-xs text-passive-1">Ranked by AI relevance</span>}
      </div>
      {availability.available && hasQuery && (
        <span className="text-xs text-passive-1">
          Sends the top results’ titles &amp; snippets and your query to your AI provider. Cloud providers will see
          them — a local model keeps it on-device.
        </span>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  )
}

export default observer(AiContextualSearch)
