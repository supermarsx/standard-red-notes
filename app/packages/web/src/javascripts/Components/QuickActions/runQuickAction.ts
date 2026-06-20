import { WebApplication } from '@/Application/WebApplication'
import { PaneLayout } from '@/Controllers/PaneController/PaneLayout'
import { isNote, isTag, SmartView, SNNote, SNTag } from '@standardnotes/snjs'
import { QuickAction } from './quickActionsStorage'
import { resolveMostRecentSNNote } from './resolveMostRecentNote'

/**
 * Resolve the target item (note / tag / smart view) for a quick action.
 */
export function resolveQuickActionTarget(
  application: WebApplication,
  action: QuickAction,
): SNNote | SNTag | SmartView | undefined {
  return application.items.findItem(action.targetUuid)
}

async function openNote(application: WebApplication, note: SNNote): Promise<void> {
  application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
  await application.itemListController.selectItemUsingInstance(note, true)
  application.paneController.setPaneLayout(PaneLayout.Editing)
}

async function navigateToTag(application: WebApplication, tag: SNTag | SmartView): Promise<void> {
  const location = isTag(tag) ? (tag.starred ? 'favorites' : 'all') : 'views'
  await application.navigationController.setSelectedTag(tag, location, { userTriggered: true })
}

/**
 * Execute a configured quick action against the REAL app controllers.
 *
 * - open-note: select + open a specific note (mirrors CommandPalette.handleItemClick).
 * - recent-in: find the most recently modified note referencing a tag, then open it.
 * - new-note-in: navigate to the tag (so the new note inherits it via
 *   ItemListController.createNewNoteController) and create+open a note.
 * - go-to: navigate to a tag / folder / smart view.
 */
export async function runQuickAction(application: WebApplication, action: QuickAction): Promise<void> {
  const target = resolveQuickActionTarget(application, action)

  if (!target) {
    return
  }

  switch (action.type) {
    case 'open-note': {
      if (isNote(target)) {
        await openNote(application, target)
      }
      break
    }

    case 'recent-in': {
      if (!isTag(target) && !(target instanceof SmartView)) {
        break
      }
      const notesInTag = application.items.itemsReferencingItem(target).filter(isNote)
      const mostRecent = resolveMostRecentSNNote(notesInTag)
      if (mostRecent) {
        await openNote(application, mostRecent)
      } else {
        // Empty collection: at least take the user to it so they see it's empty.
        await navigateToTag(application, target as SNTag | SmartView)
      }
      break
    }

    case 'new-note-in': {
      // Selecting the tag first means createNewNoteController applies it as the
      // note's tag (ItemListController reads navigationController.selected).
      if (isTag(target) || target instanceof SmartView) {
        await navigateToTag(application, target as SNTag | SmartView)
      }
      await application.itemListController.createNewNote()
      application.paneController.setPaneLayout(PaneLayout.Editing)
      break
    }

    case 'go-to': {
      if (isTag(target) || target instanceof SmartView) {
        await navigateToTag(application, target as SNTag | SmartView)
      }
      break
    }
  }
}

/** A sensible default icon per action type, used when the user hasn't set one. */
export function defaultIconForAction(action: QuickAction): string {
  switch (action.type) {
    case 'open-note':
      return 'notes'
    case 'recent-in':
      return 'restore'
    case 'new-note-in':
      return 'add'
    case 'go-to':
      return 'hashtag'
    default:
      return 'star'
  }
}

/** A derived label per action when the user hasn't set one. */
export function defaultLabelForAction(application: WebApplication, action: QuickAction): string {
  const target = resolveQuickActionTarget(application, action)
  const targetTitle = (target && 'title' in target ? (target as { title?: string }).title : undefined) || 'Unknown'

  switch (action.type) {
    case 'open-note':
      return targetTitle
    case 'recent-in':
      return `Recent in ${targetTitle}`
    case 'new-note-in':
      return `New in ${targetTitle}`
    case 'go-to':
      return targetTitle
    default:
      return targetTitle
  }
}
