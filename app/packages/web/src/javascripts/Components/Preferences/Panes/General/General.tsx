import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import Tools from './Tools'
import Defaults from './Defaults'
import Spellcheck from './Spellcheck'
import LabsPane from './Labs/Labs'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import Persistence from './Persistence'
import SmartViews from './SmartViews/SmartViews'
import Moments from './Moments'
import NewNoteDefaults from './NewNoteDefaults'
import Language from './Language'
import AutoEmptyTrash from './AutoEmptyTrash'
import DiaryMode from './DiaryMode'
import FileUploadPrivacy from './FileUploadPrivacy'
import { useApplication } from '@/Components/ApplicationProvider'

const General: FunctionComponent = () => {
  const application = useApplication()

  return (
    <PreferencesPane>
      <Language />
      <Persistence application={application} />
      <Defaults application={application} />
      <Spellcheck application={application} />
      <AutoEmptyTrash />
      <FileUploadPrivacy />
      <DiaryMode application={application} />
      <NewNoteDefaults />
      <Tools application={application} />
      <SmartViews application={application} featuresController={application.featuresController} />
      <Moments application={application} />
      <LabsPane application={application} />
    </PreferencesPane>
  )
}

export default observer(General)
