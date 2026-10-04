import { ApplicationEvent, ContentType, type SNNote } from '@standardnotes/snjs'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Switch from '@/Components/Switch/Switch'
import usePreference from '@/Hooks/usePreference'
import {
  NOTE_COVERS_ENABLED_PREF_KEY,
  countNotesWithHiddenCover,
  describeHiddenCoverCount,
  readNoteCoversEnabled,
  writeNoteCoversEnabled,
} from '@/HeroHeader/noteCoversPreference'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: the "Allow note covers" setting (t111 §3 row 4, §C).
 *
 * THIS IS THE ONLY HOME THIS SETTING HAS. Every other setting in the t111 batch
 * also lives on a surface next to the thing it controls; covers do not, because
 * the gate's whole purpose is that while it is off there is no cover UI to hang a
 * toggle on. So this card carries the full explanation rather than a label.
 *
 * ## Why the copy states a COUNT
 * The gate hides an existing cover as well as suppressing new ones (a deliberate
 * user decision, recorded in `t111-rev2.md` §C). The note itself does say so — a
 * one-line notice with [Show covers] sits in the banner's slot — but that notice
 * lives at the TOP of the document and scrolls out of existence, so a user who
 * never scrolls up never sees it. A count here is the second, global surface:
 * "covers are off, and N of your notes have one you are not seeing."
 *
 * ## Why the count may be ABSENT, and why absent is not zero
 * `countNotesWithHiddenCover` returns `undefined` — never `0` — when the notes
 * cannot be counted, and `describeHiddenCoverCount` returns `undefined` for BOTH
 * `undefined` and `0`. So this component renders no sentence at all rather than
 * "0 notes have a hidden cover", which would assert that nothing is hidden when
 * the truth is that we have not looked. That is why {@link useNotesForCoverCount}
 * hands `undefined` (and emphatically not `[]`) up until the local database is
 * actually loaded: an empty array would be counted honestly as zero, and the
 * surface would then claim more than its source establishes.
 */
const NoteCovers: FunctionComponent<Props> = ({ application }) => {
  /**
   * Re-render whenever any synced preference changes. The VALUE is deliberately
   * not taken from this hook's return: it is re-derived below by
   * `readNoteCoversEnabled`, the same function `NotesController` and the note's
   * own banner gate call, so this mirror and the note cannot drift apart. (The
   * hook's own default is `PrefDefaults[key]`, which is `undefined` for this key
   * until the generated models bundle is rebuilt — see the module header of
   * `noteCoversPreference.ts`. `readNoteCoversEnabled` hardcodes the real
   * default, `false`, and compares `=== true`.)
   */
  usePreference(NOTE_COVERS_ENABLED_PREF_KEY)
  const coversEnabled = readNoteCoversEnabled(application)

  const notes = useNotesForCoverCount(application)
  const hiddenCoverSentence = describeHiddenCoverCount(countNotesWithHiddenCover(notes, coversEnabled))

  const toggleCovers = useCallback(
    (enabled: boolean) => {
      writeNoteCoversEnabled(application, enabled).catch(console.error)
    },
    [application],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Note covers</Title>
        <div className="mt-2" data-test="note-covers-setting">
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Allow note covers</Subtitle>
              <Text>
                A cover is a banner image across the top of a note. With this off, no note offers to take one.
              </Text>
            </div>
            <Switch onChange={toggleCovers} checked={coversEnabled} />
          </div>
          <Text className="text-passive-0 mt-2">
            This setting controls whether covers are <strong className="font-semibold">shown</strong>, not just whether
            new ones can be added, so a note that already has one stops displaying it while this is off. Nothing is
            deleted: the image stays stored with the note and comes back exactly as it was when you turn this on again.
          </Text>
          {hiddenCoverSentence !== undefined && (
            // The `data-test` hook lives on a wrapper, not on <Text>: the shared
            // content primitives accept only `className` and `children`, so an
            // attribute handed to one is silently dropped.
            <div data-test="note-covers-hidden-count">
              <Text className="text-warning mt-2">{hiddenCoverSentence}</Text>
            </div>
          )}
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

/**
 * The notes to count covers in, or `undefined` while that cannot be known.
 *
 * `application.items.getDisplayableNotes()` answers `[]` both for "this account
 * has no notes" and for "the local database has not been read yet", and those are
 * different facts. `application.sync.isDatabaseLoaded()` is the only thing that
 * separates them, so it gates the read; before it flips, and if anything throws,
 * the hook reports `undefined` and the sentence above renders not at all.
 *
 * Recomputed on `LocalDataLoaded` (the transition this gate is waiting for),
 * on `CompletedFullSync` (covers added on another device), and on note item
 * changes (a cover removed from the hidden-cover notice while this pane is open),
 * so the sentence does not go stale into a falsehood.
 */
function useNotesForCoverCount(application: WebApplication): readonly SNNote[] | undefined {
  const readNotes = useCallback((): readonly SNNote[] | undefined => {
    try {
      if (!application.sync.isDatabaseLoaded()) {
        return undefined
      }
      return application.items.getDisplayableNotes()
    } catch {
      return undefined
    }
  }, [application])

  const [notes, setNotes] = useState<readonly SNNote[] | undefined>(readNotes)

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    // Trailing-edge throttle: an initial sync streams note changes in bursts and
    // this recount walks every note. One recount per burst is enough for a
    // settings card.
    const schedule = () => {
      if (timeout !== undefined) {
        return
      }
      timeout = setTimeout(() => {
        timeout = undefined
        setNotes(readNotes())
      }, 400)
    }

    setNotes(readNotes())

    const stopItems = application.items.streamItems([ContentType.TYPES.Note], () => schedule())
    const stopLoaded = application.addEventObserver(async () => {
      setNotes(readNotes())
    }, ApplicationEvent.LocalDataLoaded)
    const stopSynced = application.addEventObserver(async () => {
      schedule()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      stopItems()
      stopLoaded()
      stopSynced()
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
    }
  }, [application, readNotes])

  return notes
}

export default NoteCovers
