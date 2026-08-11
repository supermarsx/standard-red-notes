import { ComponentPropsWithoutRef, useEffect, useMemo, useRef } from 'react'
import { TabStateContext, TabState } from './useTabState'
import { applyVerticalWheelToHorizontalScroller } from './horizontalWheelScroll'

type Props = {
  state: TabState
} & ComponentPropsWithoutRef<'div'>

const TabList = ({ state, children, ...props }: Props) => {
  const tabListRef = useRef<HTMLDivElement>(null)
  const providerValue = useMemo(
    () => ({
      state,
    }),
    [state],
  )

  useEffect(() => {
    const tabList = tabListRef.current
    if (!tabList) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      let candidate: HTMLElement | null = tabList
      let scroller: HTMLElement | undefined

      // Settings tab strips commonly put overflow on a thin visual wrapper
      // around TabList. Limit the search so wheel input cannot move a distant
      // application shell unexpectedly.
      for (let depth = 0; candidate && depth < 3; depth += 1) {
        const overflowX = window.getComputedStyle(candidate).overflowX
        if (
          candidate.scrollWidth > candidate.clientWidth &&
          (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
        ) {
          scroller = candidate
          break
        }
        candidate = candidate.parentElement
      }

      if (scroller && applyVerticalWheelToHorizontalScroller(scroller, event)) {
        event.preventDefault()
      }
    }

    tabList.addEventListener('wheel', onWheel, { passive: false })
    return () => tabList.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <TabStateContext.Provider value={providerValue}>
      <div ref={tabListRef} role="tablist" aria-orientation="horizontal" {...props}>
        {children}
      </div>
    </TabStateContext.Provider>
  )
}

export default TabList
