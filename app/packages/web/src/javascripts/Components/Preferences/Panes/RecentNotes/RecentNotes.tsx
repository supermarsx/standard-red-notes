import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'

import { ResolvedRecentNote } from './RecentNotesState'

type Props = {
  application: WebApplication
}

/**
 * Renders an opened-at timestamp as a short relative string ("just now", "5m ago",
 * "3h ago", "2d ago"), falling back to a localized date for older entries.
 */
const formatRelativeTime = (openedAt: number): string => {
  const deltaMs = Date.now() - openedAt
  if (deltaMs < 0) {
    return 'just now'
  }
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 45) {
    return 'just now'
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }
  return new Date(openedAt).toLocaleDateString()
}

const RecentNoteRow: FunctionComponent<{
  entry: ResolvedRecentNote
  onOpen: (uuid: string) => void
}> = ({ entry, onOpen }) => {
  const isAvailable = entry.note != undefined
  const title = entry.note?.title?.trim() || (isAvailable ? 'Untitled note' : '(deleted)')

  const handleOpen = useCallback(() => {
    if (isAvailable) {
      onOpen(entry.uuid)
    }
  }, [isAvailable, onOpen, entry.uuid])

  return (
    <button
      className={`flex w-full items-center justify-between gap-3 rounded border border-solid border-border px-3 py-2 text-left ${
        isAvailable ? 'cursor-pointer hover:bg-contrast' : 'cursor-default opacity-60'
      }`}
      onClick={handleOpen}
      disabled={!isAvailable}
      title={isAvailable ? 'Open this note' : 'This note is no longer available'}
    >
      <span className={`min-w-0 flex-grow truncate ${isAvailable ? 'text-text' : 'italic text-passive-1'}`}>
        {title}
      </span>
      <span className="flex-shrink-0 text-xs text-passive-1">{formatRelativeTime(entry.openedAt)}</span>
    </button>
  )
}

const RecentNotes: FunctionComponent<Props> = ({ application }: Props) => {
  const state = application.recentNotesState
  const recentNotes = state.resolvedNotes

  const openNote = useCallback(
    (uuid: string) => {
      void application.itemListController.openNote(uuid)
      // Close the preferences modal so the user lands on the opened note.
      application.preferencesController.closePreferences()
    },
    [application],
  )

  const clearHistory = useCallback(() => {
    state.clear()
  }, [state])

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Title>Recent Notes</Title>
            {recentNotes.length > 0 && <Button label="Clear history" onClick={clearHistory} />}
          </div>
          <Text>
            The notes you have most recently opened, newest first. Select a note to open it. History is kept on this
            account and capped to the most recent entries.
          </Text>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>History {recentNotes.length > 0 ? `(${recentNotes.length})` : ''}</Subtitle>
          {recentNotes.length === 0 ? (
            <Text className="mt-2">You have not opened any notes yet. Open a note and it will appear here.</Text>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {recentNotes.map((entry) => (
                <RecentNoteRow key={entry.uuid} entry={entry} onOpen={openNote} />
              ))}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(RecentNotes)
