/**
 * Standard Red Notes: "hidden" folders and tags.
 *
 * WHAT HIDDEN MEANS, EXACTLY. A folder or tag marked hidden keeps its ROW out of the
 * navigation sidebar, and so do the rows of everything nested under it. Nothing else
 * changes: the item still exists, still syncs, its notes still appear in All Notes, in
 * search, in the note's own tag list and in any smart view that matches them, and the
 * item itself is still listed (and still toggleable) in "Organize folders & tags".
 *
 * WHAT IT IS NOT. It is not protection, and no copy in this feature may suggest that it
 * is. Hiding a row removes a shortcut, not access — the notes are in the same local
 * database and the same account they were in a moment ago. Vaults are the feature that
 * actually restricts access to items; hiding is housekeeping for a sidebar that has grown
 * too long.
 *
 * WHY THE FLAG IS READ THROUGH THIS MODULE RATHER THAN OFF THE MODEL. `hidden` is declared
 * on `TagContent`/`FolderContent` in `@standardnotes/models`, which web consumes through
 * the GENERATED `@standardnotes/snjs` bundle (its `types` are `dist/@types`, its `main` a
 * prebuilt webpack bundle). A newly added field is absent from both until that shared
 * artifact is rebuilt, so `tag.hidden` is a type error at `yarn tsc` and `undefined` at
 * runtime in the meantime, and a mutator setter added in the same commit does not exist on
 * the bundled `TagMutator.prototype` either — assigning to it would silently land on the
 * mutator object instead of the content being saved, and the toggle would look like it
 * worked while nothing persisted. The two helpers below therefore read and write the
 * underlying content directly, which is stable across both versions of the artifact. This
 * is the same reasoning (and the same remedy) as `TODO_FILTERS_PREF_KEY` in
 * `Components/TodoAggregate/todoFilters.ts`. Once snjs has been rebuilt in a normal build
 * cycle these can collapse to `item.hidden` and `mutator.hidden = value`.
 */

/** Shape the helpers actually touch — both halves of it are present on every real item. */
type MaybeHiddenItem = {
  hidden?: boolean
  content?: { hidden?: boolean }
}

/**
 * True when this exact folder/tag has been marked hidden by the user. Says nothing about
 * its ancestors — see `isWithinHiddenSubtree` for the question the sidebar actually asks.
 */
export const isMarkedHidden = (item: { uuid: string }): boolean => {
  const candidate = item as unknown as MaybeHiddenItem
  if (candidate.hidden === true) {
    return true
  }
  return candidate.content?.hidden === true
}

/**
 * True when `item` is marked hidden OR lives underneath something that is.
 *
 * The sidebar renders its tree recursively, so a hidden parent would already keep its
 * children off screen simply by never rendering them. Asking the ancestor question
 * explicitly makes that consequence a stated rule instead of a side effect of the
 * rendering order: it is the same answer for a child reached through its parent, for a
 * child listed in the favorites section (which is flat, and would otherwise leak a row out
 * of a hidden subtree), and for the row-level labels in "Organize folders & tags".
 *
 * `parentOf` is supplied by the caller because tags and folders resolve their parent
 * differently. The walk is guarded against a cycle in that parent chain: a corrupt
 * hierarchy must not spin here, and a cycle that contains no hidden member answers "not
 * hidden" rather than disappearing a whole branch.
 */
export const isWithinHiddenSubtree = <T extends { uuid: string }>(
  item: T,
  parentOf: (item: T) => T | undefined,
): boolean => {
  const seen = new Set<string>()
  let cursor: T | undefined = item

  while (cursor) {
    if (seen.has(cursor.uuid)) {
      return false
    }
    seen.add(cursor.uuid)

    if (isMarkedHidden(cursor)) {
      return true
    }

    cursor = parentOf(cursor)
  }

  return false
}

/**
 * Write the hidden flag inside a `changeItem` mutation callback.
 *
 * Assigning to `hidden` runs the real `TagMutator`/`FolderMutator` setter once the snjs
 * bundle carries it; the second half writes the same content key directly so the mutation
 * also lands on a bundle built before that setter existed. Both paths leave `mutableContent`
 * in the same state, and "shown" is always the ABSENCE of the key (never `false`), matching
 * how `isFolder` and `color` represent their own unset state.
 */
export const applyHiddenToMutator = (mutator: object, hidden: boolean): void => {
  const target = mutator as MaybeHiddenItem & { mutableContent?: { hidden?: boolean } }

  target.hidden = hidden

  const content = target.mutableContent
  if (!content) {
    return
  }

  if (hidden) {
    content.hidden = true
  } else {
    delete content.hidden
  }
}
