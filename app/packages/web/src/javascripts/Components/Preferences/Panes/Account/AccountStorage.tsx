import type { WebApplication } from '@/Application/WebApplication'
import StorageUsagePanel from '@/Components/StorageUsage/StorageUsagePanel'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Title } from '../../PreferencesComponents/Content'
import FilesSection from './Files'
import { observer } from 'mobx-react-lite'

const AccountStorage = ({ application }: { application: WebApplication }) => (
  <PreferencesGroup>
    <PreferencesSegment>
      <Title>Storage</Title>
      <StorageUsagePanel application={application} embedded />
      {application.featuresController.entitledToFiles && <FilesSection application={application} embedded />}
    </PreferencesSegment>
  </PreferencesGroup>
)

export default observer(AccountStorage)
