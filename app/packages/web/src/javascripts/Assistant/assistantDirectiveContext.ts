import type { AssistantChatDirective } from './assistantDirectives'

/** Ephemeral live context only; no selected plaintext is stored in tab metadata. */
export type AssistantChatContextSnapshot = { noteUuids: string[]; selectedText?: string }

export function assistantDirectiveContextMatches(
  context: AssistantChatContextSnapshot | undefined,
  directive: AssistantChatDirective,
): boolean {
  if (
    !context ||
    !directive.noteUuid ||
    context.noteUuids.length !== 1 ||
    context.noteUuids[0] !== directive.noteUuid
  ) {
    return false
  }
  return directive.contextKind === 'note'
    ? context.selectedText === undefined
    : context.selectedText === directive.selectedText
}
