import TagsList from '@/Components/Tags/TagsList'
import IconButton from '@/Components/Button/IconButton'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TagsSectionAddButton from './TagsSectionAddButton'
import BulkOrganizeModal from './BulkOrganizeModal'
import { useApplication } from '../ApplicationProvider'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'

/**
 * Standard Red Notes: the reveal path for hidden folders and tags.
 *
 * A row the user cannot find cannot be unhidden, so hiding is only safe if showing is
 * always available. This button is that guarantee in the sidebar — it puts every hidden row
 * back temporarily, in both sections at once, because there is a single reveal state rather
 * than one per section. It appears whenever anything is hidden, and stays visible while the
 * reveal is on so it can be switched back off. (The second, permanent reveal path is
 * "Organize folders & tags", which lists every folder and tag whatever this is set to.)
 *
 * The count is in the accessible name rather than a badge: the sidebar header has no room
 * for a number, and `IconButton` already publishes `title` as its `aria-label`.
 */
const RevealHiddenButton: FunctionComponent<{ navigationController: NavigationController }> = observer(
  ({ navigationController }) => {
    const hiddenCount = navigationController.hiddenFoldersCount + navigationController.hiddenTagsCount
    const isRevealing = navigationController.showHiddenNavigationItems

    if (hiddenCount === 0 && !isRevealing) {
      return null
    }

    return (
      <IconButton
        focusable={true}
        icon={isRevealing ? 'eye-off' : 'eye'}
        title={
          isRevealing
            ? 'Stop showing hidden folders and tags'
            : `Show hidden folders and tags (${hiddenCount}) — hidden only keeps a row out of this list`
        }
        className="text-neutral mr-2 p-0"
        onClick={() => navigationController.setShowHiddenNavigationItems(!isRevealing)}
      />
    )
  },
)

RevealHiddenButton.displayName = 'RevealHiddenButton'

const TagsSection: FunctionComponent = () => {
  const application = useApplication()
  const { t } = useTranslation('navigation')
  const [isOrganizeOpen, setIsOrganizeOpen] = useState(false)

  return (
    <>
      {application.navigationController.visibleStarredTags.length > 0 && (
        <section>
          <div className={'section-title-bar'}>
            <div className="section-title-bar-header">
              <div className="title text-base md:text-sm">
                <span className="font-bold">{t('favorites')}</span>
              </div>
            </div>
          </div>
          <TagsList type="favorites" />
        </section>
      )}

      <section>
        <div className={'section-title-bar'}>
          <div className="section-title-bar-header">
            <div className="title text-base md:text-sm">
              <span className="font-bold">{t('folders')}</span>
            </div>
            {!application.navigationController.isSearching && (
              <RevealHiddenButton navigationController={application.navigationController} />
            )}
            {!application.navigationController.isSearching && (
              <IconButton
                focusable={true}
                icon="list-bulleted"
                title="Organize folders & tags"
                className="text-neutral mr-2 p-0"
                onClick={() => setIsOrganizeOpen(true)}
              />
            )}
            {!application.navigationController.isSearching && <TagsSectionAddButton isFolder={true} />}
          </div>
        </div>
        <TagsList type="folders" />
      </section>

      <section>
        <div className={'section-title-bar'}>
          <div className="section-title-bar-header">
            <div className="title text-base md:text-sm">
              <span className="font-bold">{t('tags')}</span>
            </div>
            {!application.navigationController.isSearching && (
              <RevealHiddenButton navigationController={application.navigationController} />
            )}
            {!application.navigationController.isSearching && (
              <IconButton
                focusable={true}
                icon="list-bulleted"
                title="Organize folders & tags"
                className="text-neutral mr-2 p-0"
                onClick={() => setIsOrganizeOpen(true)}
              />
            )}
            {!application.navigationController.isSearching && <TagsSectionAddButton />}
          </div>
        </div>
        <TagsList type="tags" />
      </section>

      <BulkOrganizeModal isOpen={isOrganizeOpen} close={() => setIsOrganizeOpen(false)} />
    </>
  )
}

export default observer(TagsSection)
