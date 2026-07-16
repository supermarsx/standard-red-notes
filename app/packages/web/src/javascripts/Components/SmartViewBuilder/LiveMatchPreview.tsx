import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import Icon from '../Icon/Icon'
import Spinner from '../Spinner/Spinner'
import { AddSmartViewModalController } from './AddSmartViewModalController'
import { evaluatePredicateMatches, MatchPreviewResult } from './PredicateMatchPreview'

type Props = {
  controller: AddSmartViewModalController
}

const DEBOUNCE_MS = 300

/**
 * Live, debounced "Matches N items right now" preview for the guided builder.
 *
 * It reads the builder's current predicate (observed, so it re-runs as the user
 * edits conditions), then evaluates it against the app's in-memory notes/files
 * off the render path (debounced) using the resilient pure evaluator. An
 * invalid/incomplete predicate shows a gentle hint instead of a count and never
 * throws.
 */
const LiveMatchPreview = ({ controller }: Props) => {
  // Reading toJson() here (inside an observer) tracks the builder's operator +
  // predicates, so this component re-renders whenever the user edits a rule.
  const predicateJson = controller.predicateController.toJson()
  const serialized = JSON.stringify(predicateJson)

  const [result, setResult] = useState<MatchPreviewResult | null>(null)
  const [isComputing, setIsComputing] = useState(false)

  useEffect(() => {
    setIsComputing(true)
    const handle = window.setTimeout(() => {
      try {
        const items = controller.getPreviewItems()
        setResult(evaluatePredicateMatches(JSON.parse(serialized), items, controller.getTagsForItem))
      } catch {
        setResult(null)
      }
      setIsComputing(false)
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(handle)
    }
  }, [serialized, controller])

  const isUsable = result != null && result.status === 'ok'

  return (
    <div className="border-border bg-contrast flex flex-col gap-2 rounded-md border px-4 py-3" aria-live="polite">
      <div className="flex items-center gap-2">
        <Icon type="search" size="small" className="text-info flex-shrink-0" />
        <div className="text-sm font-semibold">
          {!isUsable ? (
            <span className="text-passive-0">Add a condition to preview matches</span>
          ) : (
            <span>
              Matches <span className="text-info">{result.count}</span> {result.count === 1 ? 'item' : 'items'} right
              now
            </span>
          )}
        </div>
        {isComputing && <Spinner className="h-3.5 w-3.5" />}
      </div>

      {!isUsable && (
        <div className="text-passive-1 text-xs">
          {result?.message ?? 'Choose a field, phrase, and value to see how many notes match.'}
        </div>
      )}

      {isUsable && result.sampleTitles.length > 0 && (
        <ul className="ml-1 flex flex-col gap-1">
          {result.sampleTitles.map((title, index) => (
            <li key={index} className="text-passive-0 flex items-center gap-1.5 text-sm">
              <Icon type="notes" size="small" className="text-passive-1 flex-shrink-0" />
              <span className="truncate">{title}</span>
            </li>
          ))}
          {result.count > result.sampleTitles.length && (
            <li className="text-passive-1 ml-6 text-xs">and {result.count - result.sampleTitles.length} more…</li>
          )}
        </ul>
      )}

      {isUsable && result.count === 0 && (
        <div className="text-passive-1 text-xs">No items match yet. Try loosening the conditions.</div>
      )}

      {isUsable && result.limited && (
        <div className="text-passive-1 text-xs">
          Previewing the first {result.scanned.toLocaleString()} of {result.totalAvailable.toLocaleString()} items for
          speed.
        </div>
      )}
    </div>
  )
}

export default observer(LiveMatchPreview)
