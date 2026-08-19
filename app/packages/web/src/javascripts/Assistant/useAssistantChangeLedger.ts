import { useApplication } from '@/Components/ApplicationProvider'
import { useItemAuthorization } from '@/Hooks/useItemAuthorization'
import { ApplicationEvent, ContentType, isNote, SNNote } from '@standardnotes/snjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  assistantSessionPrincipalMatches,
  AssistantSessionPrincipal,
  captureAssistantSessionPrincipal,
} from './assistantSessionPrincipal'
import { AssistantChangeRecord, getAssistantChangeLedger } from './assistantChangeLedger'

export type AssistantChangeLedgerState = {
  authorized: boolean
  note?: SNNote
  records: AssistantChangeRecord[]
}

type AssistantChangeNoteSnapshot = {
  application: ReturnType<typeof useApplication>
  noteUuid?: string
  principal: AssistantSessionPrincipal
  note?: SNNote
}

/**
 * Reads the encrypted assistant-change envelope from one note and keeps it in
 * step with local edits and sync. The authorization check intentionally stays
 * live across protected-session and vault-lock changes, so a stale React tree
 * never continues displaying another account/vault's change fragments.
 */
export function useAssistantChangeLedger(noteUuid?: string): AssistantChangeLedgerState {
  const application = useApplication()

  const findCurrentNote = useCallback(
    (expectedNoteUuid: string | undefined, expectedPrincipal: AssistantSessionPrincipal): SNNote | undefined => {
      if (!expectedNoteUuid || !expectedPrincipal.valid) {
        return undefined
      }
      const currentPrincipal = captureAssistantSessionPrincipal(application.sessions)
      if (!assistantSessionPrincipalMatches(expectedPrincipal, currentPrincipal)) {
        return undefined
      }
      const item = application.items.findItem<SNNote>(expectedNoteUuid)
      return item && item.uuid === expectedNoteUuid && isNote(item) ? item : undefined
    },
    [application.items, application.sessions],
  )

  const [snapshot, setSnapshot] = useState<AssistantChangeNoteSnapshot>(() => {
    const principal = captureAssistantSessionPrincipal(application.sessions)
    return {
      application,
      noteUuid,
      principal,
      note: findCurrentNote(noteUuid, principal),
    }
  })
  const currentPrincipal = captureAssistantSessionPrincipal(application.sessions)
  const snapshotIsCurrent =
    snapshot.application === application &&
    snapshot.noteUuid === noteUuid &&
    snapshot.note?.uuid === noteUuid &&
    assistantSessionPrincipalMatches(snapshot.principal, currentPrincipal)
  const note = snapshotIsCurrent ? snapshot.note : undefined
  const authorized = useItemAuthorization(application, note)

  useEffect(() => {
    let disposed = false

    const clear = (principal = captureAssistantSessionPrincipal(application.sessions)): void => {
      if (!disposed) {
        setSnapshot({ application, noteUuid, principal, note: undefined })
      }
    }
    const refresh = (principal = captureAssistantSessionPrincipal(application.sessions)): void => {
      if (disposed) {
        return
      }
      const current = captureAssistantSessionPrincipal(application.sessions)
      if (!assistantSessionPrincipalMatches(principal, current)) {
        clear(current)
        return
      }
      setSnapshot({
        application,
        noteUuid,
        principal: current,
        note: findCurrentNote(noteUuid, current),
      })
    }

    // Purge the previous note/principal before installing observers. The render
    // gate above already hides it synchronously during a prop/provider switch.
    clear()

    const stopNotes = application.items.streamItems<SNNote>(
      ContentType.TYPES.Note,
      ({ changed, inserted, removed }) => {
        if ([...changed, ...inserted, ...removed].some((candidate) => candidate.uuid === noteUuid)) {
          refresh()
        }
      },
    )
    const stopApplicationEvents = application.addEventObserver(async (event) => {
      if (
        event === ApplicationEvent.SignedIn ||
        event === ApplicationEvent.SignedOut ||
        event === ApplicationEvent.KeyStatusChanged
      ) {
        // Do not read while the item collection is crossing principals. A note
        // event repopulates this snapshot after the account/key swap completes.
        clear()
      }
    })

    refresh()

    return () => {
      disposed = true
      stopNotes()
      stopApplicationEvents()
    }
  }, [application, application.items, application.sessions, findCurrentNote, noteUuid])

  const records = useMemo(() => (note && authorized ? getAssistantChangeLedger(note).records : []), [authorized, note])

  return { authorized: Boolean(note && authorized), note, records }
}
