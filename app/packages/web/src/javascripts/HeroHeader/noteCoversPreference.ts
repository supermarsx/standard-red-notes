import type { PrefKey, SNNote } from '@standardnotes/snjs'
import { noteHasHeroHeader } from './heroHeader'

/**
 * Standard Red Notes: the note-covers FEATURE GATE (task t111 §C).
 *
 * Cover banners are an opt-in feature. The gate is a single synced boolean
 * preference that defaults to **off**, which means two things:
 *
 *  1. A user who has never heard of covers is never offered one — the "Add
 *     cover" affordance does not exist for them.
 *  2. A note that ALREADY carries a cover stops rendering it.
 *
 * (2) is a deliberate, user-chosen behaviour, and it is the reason this module
 * exists at all rather than a bare `getPreference` call at the render site: a
 * thing the user made disappears, so the disappearance has to be *discoverable*
 * (see the hidden-cover notice in ./HeroHeaderBanner.tsx) and *countable* (see
 * {@link countNotesWithHiddenCover}, which feeds the setting's own copy).
 *
 * ## What the gate does NOT do
 * Turning the gate off performs **no** migration, no cleanup pass and no lazy
 * rewrite. Nothing in this module reads or writes a note. The stored
 * `heroHeader` appData value is left byte-identical, so turning the gate back on
 * restores every cover exactly as it was. `getNoteHeroHeader`,
 * `normalizeHeroHeader` and `NoteHeroHeaderKey` are untouched by this feature.
 *
 * ## Why the key is a pinned string literal
 * Pinned rather than read off the `PrefKey` enum object, exactly like
 * `TODO_FILTERS_PREF_KEY` (`Components/TodoAggregate/todoFilters.ts`): web
 * consumes the enum's RUNTIME value from the generated `snjs`/`models` bundle,
 * and a newly added member is only present there once that shared artifact has
 * been rebuilt. A string enum member IS its own string at runtime, so this
 * literal is exactly `PrefKey.NoteCoversEnabled` while depending on nothing
 * generated. Read the enum member instead and the setting silently resolves to
 * `undefined` forever.
 *
 * The cast goes through `unknown` because the *type* `PrefKey.NoteCoversEnabled`
 * is not in the generated `.d.ts` either yet (the member exists in
 * `models/src/.../PrefKey.ts` but the committed `models/dist` predates it). Swap
 * the whole constant for the plain `PrefKey.NoteCoversEnabled` member once
 * models/snjs have been rebuilt in a normal build cycle.
 */
export const NOTE_COVERS_ENABLED_PREF_KEY = 'noteCoversEnabled' as unknown as PrefKey

/**
 * The shipped default: **off**. Mirrors `PrefDefaults[PrefKey.NoteCoversEnabled]`
 * and is pinned here for the same generated-bundle reason as the key above.
 */
export const NOTE_COVERS_ENABLED_DEFAULT = false

/**
 * The preference surface this module needs, as a structural type rather than
 * `WebApplication`, so the gate is unit-testable with a two-line fake.
 */
export type NoteCoversPreferenceReader = {
  getPreference: (key: PrefKey, defaultValue: boolean) => unknown
}

export type NoteCoversPreferenceWriter = {
  setPreference: (key: PrefKey, value: boolean) => Promise<void>
}

/**
 * Whether cover banners are enabled for this account.
 *
 * Coerced with `=== true` rather than returned as-is: this is a SYNCED value a
 * differently-versioned client may have written, so anything that is not
 * literally `true` reads as off — which is also the safe direction, since off
 * only ever hides a decoration and never destroys one.
 */
export function readNoteCoversEnabled(reader: NoteCoversPreferenceReader): boolean {
  return reader.getPreference(NOTE_COVERS_ENABLED_PREF_KEY, NOTE_COVERS_ENABLED_DEFAULT) === true
}

/** Turn cover banners on (the hidden-cover notice's one-click route out). */
export function writeNoteCoversEnabled(writer: NoteCoversPreferenceWriter, enabled: boolean): Promise<void> {
  return writer.setPreference(NOTE_COVERS_ENABLED_PREF_KEY, enabled)
}

/**
 * How many of `notes` carry a stored cover image, or `undefined` when the notes
 * are not available to count.
 *
 * THE ABSENCE IS THE POINT. A caller that has not loaded items yet must pass
 * `undefined` (not `[]`): "we cannot tell" and "there are none" are different
 * facts, and reporting the first as `0` is the exact claim-more-than-your-source
 * -establishes bug this codebase refuses. Everything downstream — including the
 * setting's copy — must render NOTHING for `undefined`.
 */
export function countNotesWithStoredCover(notes: readonly SNNote[] | undefined | null): number | undefined {
  if (!notes) {
    return undefined
  }
  let count = 0
  for (const note of notes) {
    if (noteHasHeroHeader(note)) {
      count += 1
    }
  }
  return count
}

/**
 * How many notes currently have a cover that is being HIDDEN by the gate — the
 * number the setting's own copy in Preferences reports, so a user who never
 * scrolls a note to its top still learns that covers exist and that some of
 * their notes have one.
 *
 * `undefined` when the notes cannot be counted (see
 * {@link countNotesWithStoredCover}). `0` when the gate is on, because then
 * nothing is hidden and zero is the honest answer rather than a stand-in for
 * ignorance.
 */
export function countNotesWithHiddenCover(
  notes: readonly SNNote[] | undefined | null,
  coversEnabled: boolean,
): number | undefined {
  const stored = countNotesWithStoredCover(notes)
  if (stored === undefined) {
    return undefined
  }
  return coversEnabled ? 0 : stored
}

/**
 * The sentence a preferences surface appends to the covers setting, or
 * `undefined` when there is nothing honest to say — which is BOTH when the count
 * is unknown and when it is zero. Returning `undefined` for zero keeps a caller
 * from rendering "0 notes have a hidden cover", which reads as a warning about
 * nothing.
 */
export function describeHiddenCoverCount(count: number | undefined): string | undefined {
  if (count === undefined || count <= 0) {
    return undefined
  }
  return count === 1 ? '1 note has a hidden cover.' : `${count} notes have a hidden cover.`
}
