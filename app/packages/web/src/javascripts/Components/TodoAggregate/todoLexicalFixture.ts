/**
 * Serialized checklist fixtures in the shape the EDITOR actually writes.
 *
 * There is exactly one of these because there were three, and all three were
 * wrong in the same way. Every Todos spec used to build
 *
 *   { type: 'listitem', children: [ text, { type: 'list', … } ] }
 *
 * — the sublist as a child of the task it belongs to. Lexical never emits that.
 * Pressing Tab runs `$handleIndent` (@lexical/list), which builds a brand-new
 * TEXTLESS `listitem` to hold the nested list and inserts it as the SIBLING
 * right after the task that was indented:
 *
 *   listitem "Parent"                      <- the task
 *   listitem [ list [ listitem "Child" ] ] <- a structural wrapper, no text
 *
 * That wrapper carries no text, so it never becomes a row — which is how the
 * Todos view came to draw every subtask at the top level while a suite built on
 * the idealized shape stayed green. A fixture that cannot occur cannot fail the
 * way the product did, so the shape lives here once and the specs import it.
 *
 * Verified against @lexical/list 0.47 by building the list in headless Lexical
 * and serializing the result.
 */

export type ChecklistTaskSpec = {
  text: string
  checked?: boolean
  children?: ChecklistTaskSpec[]
}

/**
 * Node state (`$`) to stamp on one task's own listitem.
 *
 * Only ever called for a REAL task. A structural wrapper is deliberately left
 * bare: metadata on a wrapper is exactly the case
 * `superChecklistDocument.spec` pins as "must not poison a semantic child".
 */
export type ChecklistFixtureState = (task: ChecklistTaskSpec) => Record<string, unknown> | undefined

/** One `<ul>` of `listType: 'check'`, nested the way `$handleIndent` nests. */
export function checklistListNode(tasks: ChecklistTaskSpec[], stateFor?: ChecklistFixtureState): unknown {
  const children: unknown[] = []
  for (const task of tasks) {
    const state = stateFor?.(task)
    children.push({
      type: 'listitem',
      checked: task.checked === true,
      ...(state ? { $: state } : {}),
      children: [{ type: 'text', text: task.text }],
    })
    if (task.children && task.children.length > 0) {
      children.push({
        type: 'listitem',
        checked: false,
        children: [checklistListNode(task.children, stateFor)],
      })
    }
  }
  return { type: 'list', listType: 'check', children }
}

/** A whole Super note holding one such checklist, optionally after other blocks. */
export function superChecklistNoteText(
  tasks: ChecklistTaskSpec[],
  options: { before?: unknown[]; stateFor?: ChecklistFixtureState } = {},
): string {
  return JSON.stringify({
    root: { type: 'root', children: [...(options.before ?? []), checklistListNode(tasks, options.stateFor)] },
  })
}

/** A single chain `Level 0` → … → `Level n-1`, one task per level. */
export function checklistChain(levels: number): ChecklistTaskSpec {
  let deepest: ChecklistTaskSpec = { text: `Level ${levels - 1}` }
  for (let level = levels - 2; level >= 0; level -= 1) {
    deepest = { text: `Level ${level}`, children: [deepest] }
  }
  return deepest
}
