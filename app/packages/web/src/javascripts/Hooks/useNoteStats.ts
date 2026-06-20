import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { SNNote } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import { computePlaintextStats, extractPlaintextFromNoteText, NoteStats } from '@/Utils/NoteStats'

const RECOMPUTE_DEBOUNCE_MS = 300

/**
 * Tracks live word/character/line/paragraph statistics for the currently active note.
 *
 * Returns `undefined` when there is no active note or when the active item is a file
 * (so the footer chip can hide itself).
 *
 * Updates are driven by:
 *  - `itemControllerGroup.addActiveControllerChangeObserver` — when the active
 *    tile/note changes (or switches to a file / nothing).
 *  - `NoteViewController.addNoteInnerValueChangeObserver` — when the active note's
 *    content changes (typing, remote sync, etc).
 *
 * Recomputation is debounced (~300ms) so that rapid typing doesn't thrash the
 * (synchronous, best-effort) plaintext extraction + counting.
 */
export function useNoteStats(application: WebApplication): NoteStats | undefined {
  const [stats, setStats] = useState<NoteStats | undefined>(undefined)

  useEffect(() => {
    let debounceTimeout: ReturnType<typeof setTimeout> | undefined
    let removeNoteObserver: (() => void) | undefined

    const recomputeFromNote = (note: SNNote) => {
      const plaintext = extractPlaintextFromNoteText(note.text, note.noteType)
      setStats(computePlaintextStats(plaintext))
    }

    const scheduleRecompute = (note: SNNote) => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout)
      }
      debounceTimeout = setTimeout(() => recomputeFromNote(note), RECOMPUTE_DEBOUNCE_MS)
    }

    const detachNoteObserver = () => {
      removeNoteObserver?.()
      removeNoteObserver = undefined
      if (debounceTimeout) {
        clearTimeout(debounceTimeout)
        debounceTimeout = undefined
      }
    }

    const removeActiveControllerObserver = application.itemControllerGroup.addActiveControllerChangeObserver(
      (activeController) => {
        detachNoteObserver()

        if (!(activeController instanceof NoteViewController)) {
          // No active note, or the active item is a file.
          setStats(undefined)
          return
        }

        // Compute immediately for the freshly selected note, then observe changes.
        let isInitial = true
        removeNoteObserver = activeController.addNoteInnerValueChangeObserver((note) => {
          if (isInitial) {
            isInitial = false
            recomputeFromNote(note)
          } else {
            scheduleRecompute(note)
          }
        })
      },
    )

    return () => {
      removeActiveControllerObserver()
      detachNoteObserver()
    }
  }, [application])

  return stats
}
