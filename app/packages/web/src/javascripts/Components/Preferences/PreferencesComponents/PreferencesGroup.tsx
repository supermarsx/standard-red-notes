import { FunctionComponent, ReactNode } from 'react'

const PreferencesGroup: FunctionComponent<{
  children: ReactNode
}> = ({ children }) => (
  <div className="border-border bg-default mb-4 flex max-w-full flex-col rounded border border-solid p-6">
    {children}
  </div>
)

export default PreferencesGroup
