import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import Tools from './Tools'
import Defaults from './Defaults'
import Spellcheck from './Spellcheck'
import LabsPane from './Labs/Labs'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import PreferencesSubtabs, { PreferencesSubtab } from '../../PreferencesComponents/PreferencesSubtabs'
import Persistence from './Persistence'
import SmartViews from './SmartViews/SmartViews'
import Moments from './Moments'
import NewNoteDefaults from './NewNoteDefaults'
import Language from './Language'
import AutoEmptyTrash from './AutoEmptyTrash'
import DiaryMode from './DiaryMode'
import TimezonePreference from './TimezonePreference'
import FileUploadPrivacy from './FileUploadPrivacy'
import Updates from './Updates'
import { useApplication } from '@/Components/ApplicationProvider'
import { useTabState } from '@/Components/Tabs/useTabState'

const General: FunctionComponent = () => {
  const application = useApplication()
  const tabState = useTabState({ defaultTab: 'general' })

  const tabs: PreferencesSubtab[] = [
    {
      id: 'general',
      title: 'General',
      icon: 'settings',
      content: (
        <>
          <Language />
          <Persistence application={application} />
          <TimezonePreference application={application} />
          <Updates />
        </>
      ),
    },
    {
      id: 'editor',
      title: 'Notes & editor',
      icon: 'pencil',
      content: (
        <>
          <Defaults application={application} />
          <NewNoteDefaults />
          <Spellcheck application={application} />
          <SmartViews application={application} featuresController={application.featuresController} />
        </>
      ),
    },
    {
      id: 'privacy',
      title: 'Privacy & data',
      icon: 'eye-off',
      content: (
        <>
          <FileUploadPrivacy />
          <AutoEmptyTrash application={application} />
        </>
      ),
    },
    {
      id: 'tools',
      title: 'Tools & labs',
      icon: 'code',
      content: (
        <>
          <Tools application={application} />
          <Moments application={application} />
          <DiaryMode application={application} />
          <LabsPane application={application} />
        </>
      ),
    },
  ]

  return (
    <PreferencesPane>
      <PreferencesSubtabs state={tabState} tabs={tabs} />
    </PreferencesPane>
  )
}

export default observer(General)
