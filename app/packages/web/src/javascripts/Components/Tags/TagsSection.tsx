import TagsList from '@/Components/Tags/TagsList'
import IconButton from '@/Components/Button/IconButton'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TagsSectionAddButton from './TagsSectionAddButton'
import BulkOrganizeModal from './BulkOrganizeModal'
import { useApplication } from '../ApplicationProvider'

const TagsSection: FunctionComponent = () => {
  const application = useApplication()
  const { t } = useTranslation('navigation')
  const [isOrganizeOpen, setIsOrganizeOpen] = useState(false)

  return (
    <>
      {application.navigationController.starredTags.length > 0 && (
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
              <IconButton
                focusable={true}
                icon="list-bulleted"
                title="Organize folders & tags"
                className="p-0 text-neutral mr-2"
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
              <IconButton
                focusable={true}
                icon="list-bulleted"
                title="Organize folders & tags"
                className="p-0 text-neutral mr-2"
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
