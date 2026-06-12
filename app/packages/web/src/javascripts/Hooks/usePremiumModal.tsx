import { WebApplication } from '@/Application/WebApplication'
import { FunctionComponent, createContext, useContext, ReactNode, useMemo } from 'react'

type PremiumModalContextData = {
  activate: (featureName: string) => void
  showSuperDemo: () => void
}

const noop = () => {
  // Standard Red Notes: every feature is entitled, so there is no premium
  // upgrade prompt or Super demo to show. These remain as no-ops to keep the
  // existing consumer API stable.
}

const stub: PremiumModalContextData = {
  activate: noop,
  showSuperDemo: noop,
}

const PremiumModalContext = createContext<PremiumModalContextData | null>(null)

const PremiumModalProvider_ = PremiumModalContext.Provider

export const usePremiumModal = (): PremiumModalContextData => {
  const value = useContext(PremiumModalContext)

  return value ?? stub
}

interface Props {
  application: WebApplication
  children: ReactNode
}

const PremiumModalProvider: FunctionComponent<Props> = ({ children }: Props) => {
  const value = useMemo(() => stub, [])

  return <PremiumModalProvider_ value={value}>{children}</PremiumModalProvider_>
}

PremiumModalProvider.displayName = 'PremiumModalProvider'

export default PremiumModalProvider
