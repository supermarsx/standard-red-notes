/** Detached Todo owners may persist/mutate, but must never act as interactive editors. */
export function isInteractiveChecklistEditorOwner(backgroundOwner: boolean): boolean {
  return !backgroundOwner
}
