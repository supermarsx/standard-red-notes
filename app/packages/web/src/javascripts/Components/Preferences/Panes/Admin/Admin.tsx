import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useState } from 'react'

import { WebApplication } from '@/Application/WebApplication'
import { Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import TabsContainer from '@/Components/Tabs/TabsContainer'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import AdminUsersTab, { LookedUpUser } from './AdminUsersTab'
import AdminGroupsTab from './AdminGroupsTab'
import AdminServerTab from './AdminServerTab'
import AdminAiTab from './AdminAiTab'
import AdminAuditTab from './AdminAuditTab'
import AdminLogsTab from './AdminLogsTab'
import AdminSecurityTab from './AdminSecurityTab'

type Props = {
  application: WebApplication
}

/**
 * Admin pane shell: role gate + the "admin role missing on the server" notice,
 * with the actual tooling split into sub-tabs (Users / Groups & roles / Server /
 * Audit log).
 * Each tab's content lives in its own component and loads its data when the tab
 * is opened; only cross-tab state (the looked-up user and the 403 notice) is
 * kept here so it survives tab switches within a session.
 */
const Admin: FunctionComponent<Props> = ({ application }: Props) => {
  const isAdmin = application.featuresController.isAdminUser()

  // True when an admin endpoint answered 403: the client believes this user is
  // an admin, but the session's server-side role claims don't carry the admin
  // role (yet). Surfaced as an inline notice instead of failing silently, and
  // shown regardless of which tab is active.
  const [adminRoleMissingOnServer, setAdminRoleMissingOnServer] = useState(false)

  const noteIfForbidden = useCallback((response: { status?: number }) => {
    if (response.status === 403) {
      setAdminRoleMissingOnServer(true)
    }
  }, [])

  // The looked-up user lives here (not in the Users tab) so it is remembered
  // when switching tabs — inactive tab panels are unmounted.
  const [email, setEmail] = useState('')
  const [user, setUser] = useState<LookedUpUser | undefined>(undefined)

  // The last-selected tab is remembered for as long as the pane stays open.
  const tabState = useTabState({ defaultTab: 'users' })

  if (!isAdmin) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Admin</Title>
            <Text>
              You do not have administrator access. This panel is only available to users with the internal team role.
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      {adminRoleMissingOnServer && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Admin access not active on the server yet</Title>
            <Text>
              Your session doesn&apos;t carry the admin role yet &mdash; sign out and back in, or wait for the session
              to refresh, then reopen this pane.
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Administrator</Title>
          <Text>
            You are signed in with the internal team (admin) role. Use the tools below to manage other users' access to
            AI features and to control whether new signups are allowed. All actions are re-verified against your role on
            the server.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <TabsContainer
        className="mb-4 bg-default"
        tabs={[
          { id: 'users', title: 'Users', icon: 'user' },
          { id: 'groups', title: 'Groups & roles', icon: 'group' },
          { id: 'server', title: 'Server', icon: 'server' },
          { id: 'ai', title: 'AI', icon: 'dashboard' },
          { id: 'logs', title: 'Logs', icon: 'list-bulleted' },
          { id: 'audit', title: 'Audit log', icon: 'history' },
          { id: 'security', title: 'Security', icon: 'security' },
        ]}
        state={tabState}
      >
        <TabPanel state={tabState} id="users" className="p-6">
          <AdminUsersTab
            application={application}
            noteIfForbidden={noteIfForbidden}
            email={email}
            setEmail={setEmail}
            user={user}
            setUser={setUser}
          />
        </TabPanel>
        <TabPanel state={tabState} id="groups" className="p-6">
          <AdminGroupsTab application={application} noteIfForbidden={noteIfForbidden} />
        </TabPanel>
        <TabPanel state={tabState} id="server" className="p-6">
          <AdminServerTab application={application} noteIfForbidden={noteIfForbidden} />
        </TabPanel>
        <TabPanel state={tabState} id="ai" className="p-6">
          <AdminAiTab application={application} noteIfForbidden={noteIfForbidden} />
        </TabPanel>
        <TabPanel state={tabState} id="logs" className="p-6">
          <AdminLogsTab application={application} noteIfForbidden={noteIfForbidden} />
        </TabPanel>
        <TabPanel state={tabState} id="audit" className="p-6">
          <AdminAuditTab application={application} noteIfForbidden={noteIfForbidden} />
        </TabPanel>
        <TabPanel state={tabState} id="security" className="p-6">
          <AdminSecurityTab
            application={application}
            noteIfForbidden={noteIfForbidden}
            goToTab={tabState.setActiveTab}
          />
        </TabPanel>
      </TabsContainer>
    </PreferencesPane>
  )
}

export default observer(Admin)
