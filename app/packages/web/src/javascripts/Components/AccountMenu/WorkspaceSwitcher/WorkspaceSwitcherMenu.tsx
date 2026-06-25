import { WebApplicationGroup } from '@/Application/WebApplicationGroup'
import { ApplicationDescriptor, ApplicationGroupEvent, ButtonType } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import WorkspaceMenuItem from './WorkspaceMenuItem'
import { useApplication } from '@/Components/ApplicationProvider'
import MenuSection from '@/Components/Menu/MenuSection'
import { useTranslation } from 'react-i18next'
import { achievements, METRICS } from '@/Achievements'

type Props = {
  mainApplicationGroup: WebApplicationGroup
  hideWorkspaceOptions?: boolean
}

const WorkspaceSwitcherMenu: FunctionComponent<Props> = ({
  mainApplicationGroup,
  hideWorkspaceOptions = false,
}: Props) => {
  const application = useApplication()
  const { t } = useTranslation('auth')

  const [applicationDescriptors, setApplicationDescriptors] = useState<ApplicationDescriptor[]>(
    mainApplicationGroup.getDescriptors(),
  )

  useEffect(() => {
    const applicationDescriptors = mainApplicationGroup.getDescriptors()
    setApplicationDescriptors(applicationDescriptors)

    const removeAppGroupObserver = mainApplicationGroup.addEventObserver((event) => {
      if (event === ApplicationGroupEvent.DescriptorsDataChanged) {
        const applicationDescriptors = mainApplicationGroup.getDescriptors()
        setApplicationDescriptors(applicationDescriptors)
      }
    })

    return () => {
      removeAppGroupObserver()
    }
  }, [mainApplicationGroup])

  const signoutAll = useCallback(async () => {
    const confirmed = await application.alerts.confirm(
      t('signOutAllWorkspacesConfirm'),
      undefined,
      t('signOutAll'),
      ButtonType.Danger,
    )
    if (!confirmed) {
      return
    }
    mainApplicationGroup.signOutAllWorkspaces().catch(console.error)
  }, [mainApplicationGroup, application, t])

  const destroyWorkspace = useCallback(() => {
    application.accountMenuController.setSigningOut(true)
  }, [application])

  const activateWorkspace = useCallback(
    async (descriptor: ApplicationDescriptor) => {
      achievements.increment(METRICS.workspaceSwitchTotal)
      if (mainApplicationGroup.getDescriptors().length > 1) {
        achievements.markEvent(METRICS.multipleAccountsUsed)
      }
      void mainApplicationGroup.unloadCurrentAndActivateDescriptor(descriptor)
    },
    [mainApplicationGroup],
  )

  const addAnotherWorkspace = useCallback(async () => {
    void mainApplicationGroup.unloadCurrentAndCreateNewDescriptor()
  }, [mainApplicationGroup])

  return (
    <Menu a11yLabel={t('workspaceSwitcherMenuLabel')} className="focus:shadow-none">
      <MenuSection>
        {applicationDescriptors.map((descriptor) => (
          <WorkspaceMenuItem
            key={descriptor.identifier}
            descriptor={descriptor}
            hideOptions={hideWorkspaceOptions}
            onDelete={destroyWorkspace}
            onClick={() => activateWorkspace(descriptor)}
            renameDescriptor={(label: string) => mainApplicationGroup.renameDescriptor(descriptor, label)}
          />
        ))}
      </MenuSection>

      <MenuSection>
        <MenuItem onClick={addAnotherWorkspace}>
          <Icon type="user-add" className="mr-2 text-neutral" />
          {t('addAnotherWorkspace')}
        </MenuItem>
        {!hideWorkspaceOptions && (
          <MenuItem onClick={signoutAll}>
            <Icon type="signOut" className="mr-2 text-neutral" />
            {t('signOutAllWorkspaces')}
          </MenuItem>
        )}
      </MenuSection>
    </Menu>
  )
}

export default observer(WorkspaceSwitcherMenu)
