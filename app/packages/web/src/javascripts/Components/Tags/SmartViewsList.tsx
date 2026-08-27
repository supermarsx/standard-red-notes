import { FeaturesController } from '@/Controllers/FeaturesController'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { SmartView, SystemViewId } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SmartViewsListItem from './SmartViewsListItem'
import { useListKeyboardNavigation } from '@/Hooks/useListKeyboardNavigation'

type Props = {
  navigationController: NavigationController
  featuresController: FeaturesController
  setEditingSmartView: (smartView: SmartView) => void
}

const SmartViewsList: FunctionComponent<Props> = ({
  navigationController,
  featuresController,
  setEditingSmartView,
}: Props) => {
  /**
   * Standard Red Notes: the Files system view is deliberately not listed here.
   * Files are managed in the dedicated Files tab (FilesSectionButton →
   * AppPaneId.Files); listing both put two identically-named, identically-iconed
   * "Files" entries in the same sidebar opening two different UIs over the same
   * data. Filtering at the render site rather than on the controller keeps
   * `smartViews[0]` (the home navigation view) and the search filter intact.
   */
  const allViews = useMemo(
    () => navigationController.smartViews.filter((view) => view.uuid !== SystemViewId.Files),
    [navigationController.smartViews],
  )
  const { t } = useTranslation('navigation')

  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useListKeyboardNavigation(container, {
    initialFocus: 0,
    shouldAutoFocus: false,
    shouldWrapAround: false,
    resetLastFocusedOnBlur: true,
  })

  if (allViews.length === 0 && navigationController.isSearching) {
    return <div className="px-4 py-1 text-base opacity-60 lg:text-sm">{t('noSmartViewsFound')}</div>
  }

  return (
    <div ref={setContainer}>
      {allViews.map((view) => {
        return (
          <SmartViewsListItem
            key={view.uuid}
            view={view}
            tagsState={navigationController}
            features={featuresController}
            setEditingSmartView={setEditingSmartView}
          />
        )
      })}
    </div>
  )
}

export default observer(SmartViewsList)
