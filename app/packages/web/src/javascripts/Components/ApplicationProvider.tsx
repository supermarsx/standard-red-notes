import { ReactNode, createContext, useContext, memo } from 'react'

import { observer } from 'mobx-react-lite'
import { WebApplication } from '@/Application/WebApplication'

const ApplicationContext = createContext<WebApplication | undefined>(undefined)

export const useApplication = () => {
  const value = useContext(ApplicationContext)

  if (!value) {
    throw new Error('Component must be a child of <ApplicationProvider />')
  }

  return value
}

/**
 * Standard Red Notes: the application if there is one, `undefined` if there is
 * not — for a component that renders on BOTH the authed app and the PUBLIC
 * share page.
 *
 * The share page has no `<ApplicationProvider>` by design: `App.tsx`
 * early-returns into the public viewer before `ApplicationGroupView` mounts
 * (see `SharedView/SharedSuperContent.tsx`). `useApplication` throws there, and
 * a throw inside a Lexical decorator node is caught by the viewer's boundary
 * and replaced with "this block could not be displayed" — so a node that reads
 * a preference must be able to ask without asserting. Inside the app a missing
 * provider is still a bug, which is why `useApplication` keeps throwing and
 * this is a separate, explicitly-named accessor rather than a relaxation of it.
 */
export const useApplicationOrNull = () => useContext(ApplicationContext)

type ChildrenProps = {
  children: ReactNode
}

type ProviderProps = {
  application: WebApplication
} & ChildrenProps

const MemoizedChildren = memo(({ children }: ChildrenProps) => <>{children}</>)

const ApplicationProvider = ({ application, children }: ProviderProps) => {
  return (
    <ApplicationContext.Provider value={application}>
      <MemoizedChildren children={children} />
    </ApplicationContext.Provider>
  )
}

export default observer(ApplicationProvider)
