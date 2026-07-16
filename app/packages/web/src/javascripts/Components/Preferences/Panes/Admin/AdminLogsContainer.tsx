import { FunctionComponent } from 'react'

import { WebApplication } from '@/Application/WebApplication'
import { Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import Icon from '@/Components/Icon/Icon'
import AdminLogsTab from './AdminLogsTab'
import AdminAuditTab from './AdminAuditTab'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

/**
 * Hosts the two logging surfaces under a single top-level "Logs" tab: the live
 * server-logs tail (AdminLogsTab) and the durable audit log (AdminAuditTab),
 * which used to be its own top-level tab. Both child components are rendered
 * unchanged; each still loads its own data on mount. Every `Tab` here has a
 * matching `TabPanel` and the `defaultTab` id exists (vanish-guard, MEMORY:
 * verify UI render paths).
 */
const AdminLogsContainer: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const subTab = useTabState({ defaultTab: 'logs' })

  return (
    <>
      <PreferencesSegment>
        <Title>Logs</Title>
        <Text>
          Server logs are the live tail of the running services. Audit logs are the durable record of admin and
          security-relevant actions.
        </Text>
        <div className="border-border mt-3 border-b">
          <TabList state={subTab} className="flex">
            <Tab id="logs" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="list-bulleted" size="medium" />
              Logs
            </Tab>
            <Tab id="audit" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="history" size="medium" />
              Audit logs
            </Tab>
          </TabList>
        </div>
      </PreferencesSegment>

      <TabPanel state={subTab} id="logs">
        <AdminLogsTab application={application} noteIfForbidden={noteIfForbidden} />
      </TabPanel>
      <TabPanel state={subTab} id="audit">
        <AdminAuditTab application={application} noteIfForbidden={noteIfForbidden} />
      </TabPanel>
    </>
  )
}

export default AdminLogsContainer
