import TagsList from '@/Components/Tags/TagsList'
import { observer } from 'mobx-react-lite'
import { FunctionComponent } from 'react'
import TagsSectionAddButton from './TagsSectionAddButton'
import { useApplication } from '../ApplicationProvider'

const TagsSection: FunctionComponent = () => {
  const application = useApplication()

  return (
    <>
      {application.navigationController.starredTags.length > 0 && (
        <section>
          <div className={'section-title-bar'}>
            <div className="section-title-bar-header">
              <div className="title text-base md:text-sm">
                <span className="font-bold">Favorites</span>
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
              <span className="font-bold">Folders</span>
            </div>
            {!application.navigationController.isSearching && <TagsSectionAddButton isFolder={true} />}
          </div>
        </div>
        <TagsList type="folders" />
      </section>

      <section>
        <div className={'section-title-bar'}>
          <div className="section-title-bar-header">
            <div className="title text-base md:text-sm">
              <span className="font-bold">Tags</span>
            </div>
            {!application.navigationController.isSearching && <TagsSectionAddButton />}
          </div>
        </div>
        <TagsList type="tags" />
      </section>
    </>
  )
}

export default observer(TagsSection)
