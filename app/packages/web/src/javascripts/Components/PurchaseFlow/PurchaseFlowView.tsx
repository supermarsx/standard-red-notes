import { WebApplication } from '@/Application/WebApplication'
import { PurchaseFlowPane } from '@/Controllers/PurchaseFlow/PurchaseFlowPane'
import { observer } from 'mobx-react-lite'
import { FunctionComponent } from 'react'
import CreateAccount from './Panes/CreateAccount'
import SignIn from './Panes/SignIn'
import { SNLogoFull } from '@standardnotes/icons'
import Icon from '../Icon/Icon'

type PaneSelectorProps = {
  currentPane: PurchaseFlowPane
} & PurchaseFlowViewProps

type PurchaseFlowViewProps = {
  application: WebApplication
}

const PurchaseFlowPaneSelector: FunctionComponent<PaneSelectorProps> = ({ currentPane, application }) => {
  switch (currentPane) {
    case PurchaseFlowPane.CreateAccount:
      return <CreateAccount application={application} />
    case PurchaseFlowPane.SignIn:
      return <SignIn application={application} />
  }
}

const PurchaseFlowView: FunctionComponent<PurchaseFlowViewProps> = ({ application }) => {
  const { currentPane } = application.purchaseFlowController

  return (
    <div className="z-purchase-flow bg-passive-super-light absolute top-0 left-0 flex h-full w-full items-center justify-center overflow-hidden">
      <div className="relative w-fit">
        <div className="rounded-0 border-border bg-default relative mb-4 w-full border border-solid px-8 py-8 md:rounded md:p-12">
          <button
            className="hover:bg-info-backdrop absolute top-4 right-4 rounded-full p-1"
            onClick={() => {
              application.purchaseFlowController.closePurchaseFlow()
            }}
          >
            <Icon type="close" className="text-neutral" />
          </button>
          <SNLogoFull className="mb-5 h-7" />
          <PurchaseFlowPaneSelector currentPane={currentPane} application={application} />
        </div>
      </div>
    </div>
  )
}

export default observer(PurchaseFlowView)
