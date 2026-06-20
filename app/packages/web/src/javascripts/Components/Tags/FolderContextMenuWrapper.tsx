import { observer } from 'mobx-react-lite'
import { isFolderItem } from '@standardnotes/snjs'
import FolderContextMenu from './FolderContextMenu'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { FeaturesController } from '@/Controllers/FeaturesController'

type Props = {
  navigationController: NavigationController
  featuresController: FeaturesController
}

const FolderContextMenuWrapper = ({ navigationController, featuresController }: Props) => {
  const selectedFolder = navigationController.contextMenuFolder

  if (!selectedFolder || !isFolderItem(selectedFolder)) {
    return null
  }

  return (
    <FolderContextMenu
      navigationController={navigationController}
      isEntitledToFolders={featuresController.hasFolders}
      selectedFolder={selectedFolder}
    />
  )
}

export default observer(FolderContextMenuWrapper)
