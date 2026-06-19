import RevisionContentLocked from './RevisionContentLocked'
import { observer } from 'mobx-react-lite'
import { NoteHistoryController } from '@/Controllers/NoteHistory/NoteHistoryController'
import { RevisionContentState } from '@/Controllers/NoteHistory/Types'
import Spinner from '@/Components/Spinner/Spinner'
import { ReadonlyNoteContent } from '../NoteView/ReadonlyNoteContent'
import { SNNote } from '@standardnotes/snjs'
import RevisionDiffView from './RevisionDiffView'

type Props = {
  noteHistoryController: NoteHistoryController
  note: SNNote
}

const CompareControls = observer(({ noteHistoryController }: { noteHistoryController: NoteHistoryController }) => {
  const { isComparing, setIsComparing, compareTarget, setCompareTarget } = noteHistoryController

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border bg-default px-4 py-2 text-sm">
      <button
        className={
          isComparing
            ? 'rounded border border-info bg-info px-3 py-1 text-info-contrast focus:shadow-none focus:outline-none'
            : 'rounded border border-border bg-default px-3 py-1 text-text hover:bg-contrast focus:shadow-none focus:outline-none'
        }
        onClick={() => setIsComparing(!isComparing)}
      >
        {isComparing ? 'Comparing' : 'Compare'}
      </button>
      {isComparing && (
        <label className="flex items-center gap-2 text-text">
          <span className="text-passive-1">Compare with</span>
          <select
            className="rounded border border-border bg-default px-2 py-1 text-text focus:shadow-none focus:outline-none"
            value={compareTarget}
            onChange={(event) => setCompareTarget(event.target.value as 'current' | 'previous')}
          >
            <option value="current">Current note</option>
            <option value="previous">Previous revision</option>
          </select>
        </label>
      )}
    </div>
  )
})

const HistoryModalContentPane = ({ noteHistoryController, note }: Props) => {
  const { selectedRevision, contentState, isComparing, comparisonContent, compareTarget } = noteHistoryController

  const renderBody = () => {
    switch (contentState) {
      case RevisionContentState.Idle:
        return (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-sm text-passive-0">
            No revision selected
          </div>
        )
      case RevisionContentState.Loading:
        return <Spinner className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2" />
      case RevisionContentState.Loaded:
        if (!selectedRevision) {
          return null
        }
        if (isComparing) {
          if (!comparisonContent) {
            return (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-sm text-passive-0">
                {compareTarget === 'previous'
                  ? 'No previous revision available to compare.'
                  : 'Loading comparison…'}
              </div>
            )
          }
          // For "previous" the older content is the comparison; for "current"
          // the live note is newer, so the selected revision is the old side.
          const isComparingWithPrevious = compareTarget === 'previous'
          const oldContent = isComparingWithPrevious ? comparisonContent : selectedRevision.payload.content
          const newContent = isComparingWithPrevious ? selectedRevision.payload.content : comparisonContent
          const oldLabel = isComparingWithPrevious ? 'Previous revision' : 'Selected revision'
          const newLabel = isComparingWithPrevious ? 'Selected revision' : 'Current note'
          return (
            <RevisionDiffView
              oldContent={oldContent}
              newContent={newContent}
              oldLabel={oldLabel}
              newLabel={newLabel}
            />
          )
        }
        return <ReadonlyNoteContent note={note} content={selectedRevision.payload.content} showLinkedItems={false} />
      case RevisionContentState.NotEntitled:
        return <RevisionContentLocked />
      default:
        return null
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-grow flex-col">
      <CompareControls noteHistoryController={noteHistoryController} />
      <div className="relative min-h-0 flex-grow">{renderBody()}</div>
    </div>
  )
}

export default observer(HistoryModalContentPane)
