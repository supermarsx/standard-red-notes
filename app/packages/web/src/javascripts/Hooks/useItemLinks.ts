import { useApplication } from '@/Components/ApplicationProvider'
import { useLinkingController } from '@/Controllers/LinkingControllerProvider'
import { ContentType, DecryptedItem, FolderContentType } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'

export const useItemLinks = (item: DecryptedItem | undefined) => {
  const application = useApplication()
  const linkingController = useLinkingController()
  const { getLinkedNotesForItem, getNotesLinkingToItem, getFilesLinksForItem, getLinkedTagsForItem } = linkingController

  const [, refresh] = useState(Date.now())

  const notesLinkedToItem = getLinkedNotesForItem(item) || []
  const notesLinkingToItem = getNotesLinkingToItem(item) || []
  const { filesLinkedToItem, filesLinkingToItem } = getFilesLinksForItem(item)
  const tagsLinkedToItem = getLinkedTagsForItem(item) || []

  useEffect(
    () =>
      application.items.streamItems(
        // Folders included so that filing a note (which mutates only the folder's
        // references, never the note's) still refreshes the consumers of this hook.
        [ContentType.TYPES.Note, ContentType.TYPES.File, ContentType.TYPES.Tag, FolderContentType],
        () => {
          refresh(Date.now())
        },
      ),
    [application],
  )

  return {
    notesLinkedToItem,
    notesLinkingToItem,
    filesLinkedToItem,
    filesLinkingToItem,
    tagsLinkedToItem,
  }
}
