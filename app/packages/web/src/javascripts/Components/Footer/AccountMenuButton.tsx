import { classNames } from '@standardnotes/utils'
import { useEffect, useMemo, useRef } from 'react'
import AccountMenu, { AccountMenuProps } from '../AccountMenu/AccountMenu'
import Avatar from '@/Avatar/Avatar'
import Popover from '../Popover/Popover'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { observer } from 'mobx-react-lite'
import { AccountMenuController } from '@/Controllers/AccountMenu/AccountMenuController'
import { useApplication } from '../ApplicationProvider'

type Props = AccountMenuProps & {
  controller: AccountMenuController
  hasError: boolean
  toggleMenu: () => void
  user: unknown
}

const AccountMenuButton = ({ hasError, controller, mainApplicationGroup, onClickOutside, toggleMenu, user }: Props) => {
  const application = useApplication()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { show: isOpen } = controller

  const email = useMemo(() => application.sessions.getUser()?.email, [application, user])

  useEffect(
    () => application.commands.add('open-acc-menu', 'Open account menu', toggleMenu, 'account-circle'),
    [application.commands, toggleMenu],
  )

  return (
    <>
      <StyledTooltip label="Open account menu">
        <button
          ref={buttonRef}
          onClick={toggleMenu}
          className={classNames(
            isOpen ? 'bg-border' : '',
            'flex h-full w-8 cursor-pointer items-center justify-center rounded-full',
          )}
        >
          <div className={classNames('hover:text-info', hasError ? 'text-danger' : user ? 'text-info' : 'text-neutral')}>
            <Avatar email={email} size={20} />
          </div>
        </button>
      </StyledTooltip>
      <Popover
        title="Account"
        anchorElement={buttonRef}
        open={isOpen}
        togglePopover={toggleMenu}
        side="top"
        align="start"
        className="py-2"
      >
        <AccountMenu onClickOutside={onClickOutside} mainApplicationGroup={mainApplicationGroup} />
      </Popover>
    </>
  )
}

export default observer(AccountMenuButton)
