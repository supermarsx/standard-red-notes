import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import ProtectedItemOverlay from '@/Components/ProtectedItemOverlay/ProtectedItemOverlay'
import FileViewWithoutProtection from './FileViewWithoutProtection'
import { FileViewProps } from './FileViewProps'
import { useItemAuthorization } from '@/Hooks/useItemAuthorization'

const FileView = ({ application, file }: FileViewProps) => {
  const [shouldShowProtectedOverlay, setShouldShowProtectedOverlay] = useState(false)
  const isAuthorized = useItemAuthorization(application, file)

  useEffect(() => {
    application.filesController.setShowProtectedOverlay(!isAuthorized)
  }, [application.filesController, isAuthorized])

  useEffect(() => {
    setShouldShowProtectedOverlay(application.filesController.showProtectedOverlay)
  }, [application.filesController.showProtectedOverlay])

  const dismissProtectedOverlay = useCallback(async () => {
    let showFileContents = true

    if (application.hasProtectionSources()) {
      showFileContents = await application.protections.authorizeItemAccess(file)
    }

    if (showFileContents && application.isAuthorizedToRenderItem(file)) {
      setShouldShowProtectedOverlay(false)
    }
  }, [application, file])

  return shouldShowProtectedOverlay || !isAuthorized ? (
    <ProtectedItemOverlay
      showAccountMenu={application.showAccountMenu}
      hasProtectionSources={application.hasProtectionSources()}
      onViewItem={dismissProtectedOverlay}
      itemType={'file'}
    />
  ) : (
    <FileViewWithoutProtection application={application} file={file} />
  )
}

export default observer(FileView)
