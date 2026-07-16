import { observer } from 'mobx-react-lite'
import { useMemo } from 'react'
import Icon from '../Icon/Icon'
import { AddSmartViewModalController } from './AddSmartViewModalController'
import { getPredicatePresets, PredicatePreset } from './PredicateGuidance'
import { isBuilderCompatiblePredicate } from './friendlyPredicate'

type Props = {
  controller: AddSmartViewModalController
}

/**
 * "Start from a template" strip shown at the top of the guided Builder tab.
 * Clicking a card loads a ready-made, working smart view into the builder (and
 * suggests a title) so a non-technical user gets a result in one click, then
 * can tweak the conditions.
 *
 * Only presets that map cleanly onto the guided rows are shown here; more
 * advanced examples (e.g. tag-based ones) remain available under the
 * Custom (JSON) tab.
 */
const QuickStartTemplates = ({ controller }: Props) => {
  const templates = useMemo<PredicatePreset[]>(
    () => getPredicatePresets().filter((preset) => isBuilderCompatiblePredicate(preset.predicate)),
    [],
  )

  if (templates.length === 0) {
    return null
  }

  return (
    <div className="border-border bg-contrast flex flex-col gap-2 rounded-md border px-4 py-3">
      <div className="flex items-center gap-2">
        <Icon type="star" size="small" className="text-info flex-shrink-0" />
        <div className="text-sm font-semibold">Start from a template</div>
      </div>
      <div className="text-passive-1 text-xs">
        Pick a ready-made view to get going, then tweak the conditions below.
      </div>
      <div className="flex flex-wrap gap-2">
        {templates.map((preset) => (
          <button
            key={preset.label}
            type="button"
            title={preset.description}
            className="border-border bg-default hover:bg-info hover:text-info-contrast focus:bg-info focus:text-info-contrast flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm focus:outline-none"
            onClick={() => {
              controller.applyTemplate(preset)
            }}
          >
            <Icon type="add" size="small" className="flex-shrink-0" />
            <span>{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default observer(QuickStartTemplates)
