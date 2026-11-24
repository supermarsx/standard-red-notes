import { observer } from 'mobx-react-lite'
import { Fragment, FunctionComponent, useMemo, useState } from 'react'
import { useListKeyboardNavigation } from '@/Hooks/useListKeyboardNavigation'
import HistoryListItem from './HistoryListItem'
import { previewHistoryEntryTitle } from './utils'
import { RevisionMetadata } from '@standardnotes/snjs'
import { NoteHistoryController } from '@/Controllers/NoteHistory/NoteHistoryController'
import Spinner from '@/Components/Spinner/Spinner'

type RemoteHistoryListProps = {
  noteHistoryController: NoteHistoryController
  onSelectRevision: () => void
}

const RemoteHistoryList: FunctionComponent<RemoteHistoryListProps> = ({ noteHistoryController, onSelectRevision }) => {
  const { remoteHistory, isFetchingRemoteHistory, selectRemoteRevision, selectedEntry } = noteHistoryController

  const [listElement, setListElement] = useState<HTMLDivElement | null>(null)

  useListKeyboardNavigation(listElement)

  const remoteHistoryLength = useMemo(() => remoteHistory?.map((group) => group.entries).flat().length, [remoteHistory])

  return (
    <div
      className={`flex h-full w-full flex-col focus:shadow-none ${
        isFetchingRemoteHistory || !remoteHistoryLength ? 'items-center justify-center' : ''
      }`}
      ref={setListElement}
    >
      {isFetchingRemoteHistory && <Spinner className="h-5 w-5" />}
      {remoteHistory?.map((group) => {
        if (group.entries && group.entries.length) {
          return (
            <Fragment key={group.title}>
              <div className="text-passive-0 mt-2.5 mb-1 px-3 text-sm font-semibold uppercase select-none">
                {group.title}
              </div>
              {group.entries.map((entry) => (
                <HistoryListItem
                  key={entry.uuid}
                  isSelected={(selectedEntry as RevisionMetadata)?.uuid === entry.uuid}
                  onClick={() => {
                    void selectRemoteRevision(entry)
                    onSelectRevision()
                  }}
                >
                  <div className="flex flex-grow items-center justify-between">
                    <div>
                      <div>{previewHistoryEntryTitle(entry)}</div>
                      {entry.automatic_checkpoint && (
                        <div className="text-passive-0 mt-0.5 text-xs">
                          Automatic checkpoint · {entry.coalesced_changes ?? 1} combined saves
                        </div>
                      )}
                      {entry.edited_by_uuid && (
                        <div className="text-passive-0 mt-0.5 text-xs">
                          edited by {entry.edited_by_uuid.slice(0, 8)}
                        </div>
                      )}
                    </div>
                  </div>
                </HistoryListItem>
              ))}
            </Fragment>
          )
        } else {
          return null
        }
      })}
      {!remoteHistoryLength && !isFetchingRemoteHistory && (
        <div className="text-passive-0 text-sm select-none">No remote history found</div>
      )}
    </div>
  )
}

export default observer(RemoteHistoryList)
