import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import { PreferencesSessionController } from './Controller/PreferencesSessionController'
import Backups from '@/Components/Preferences/Panes/Backups/Backups'
import Appearance from './Panes/Appearance'
import General from './Panes/General/General'
import AccountPreferences from './Panes/Account/AccountPreferences'
import Security from './Panes/Security/Security'
import Documentation from './Panes/Documentation/Documentation'
import { PreferencesProps } from './PreferencesProps'
import WhatsNew from './Panes/WhatsNew/WhatsNew'
import HomeServer from './Panes/HomeServer/HomeServer'
import Vaults from './Panes/Vaults/Vaults'
import PluginsPane from './Panes/Plugins/PluginsPane'
import Assistant from './Panes/Assistant/Assistant'
import Admin from './Panes/Admin/Admin'
import Shares from './Panes/Shares/Shares'
import SurvivorSwitch from './Panes/SurvivorSwitch/SurvivorSwitch'
import Conflicts from './Panes/Conflicts/Conflicts'
import RecentNotes from './Panes/RecentNotes/RecentNotes'
import Achievements from './Panes/Achievements/Achievements'
import Sharing from './Panes/Sharing/Sharing'
import Sync from './Panes/Sync/Sync'

const PaneSelector: FunctionComponent<PreferencesProps & { menu: PreferencesSessionController }> = ({
  menu,
  application,
}) => {
  switch (menu.selectedPaneId) {
    case 'general':
      return <General />
    case 'account':
      return <AccountPreferences application={application} />
    case 'appearance':
      return <Appearance application={application} />
    case 'assistant':
      return <Assistant application={application} />
    case 'admin':
      return <Admin application={application} />
    case 'shares':
      return <Shares application={application} />
    case 'survivor-switch':
      return <SurvivorSwitch application={application} />
    case 'conflicts':
      return <Conflicts application={application} />
    case 'recent-notes':
      return <RecentNotes application={application} />
    case 'achievements':
      return <Achievements application={application} />
    case 'home-server':
      return <HomeServer />
    case 'security':
      return <Security application={application} />
    case 'vaults':
      return <Vaults />
    case 'sharing':
      return <Sharing application={application} />
    case 'sync':
      return <Sync application={application} />
    case 'backups':
      return <Backups application={application} />
    case 'shortcuts':
      return null
    case 'plugins':
      return <PluginsPane pluginsLatestVersions={menu.extensionsLatestVersions} />
    case 'accessibility':
      return null
    case 'help-feedback':
      return <Documentation />
    case 'whats-new':
      return <WhatsNew application={application} />
    default:
      return <General />
  }
}

export default observer(PaneSelector)
