import { WebApplication } from '@/Application/WebApplication'
import { PaneLayout } from '@/Controllers/PaneController/PaneLayout'
import { isNote, isTag, SmartView, SNNote, SNTag, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { HomeCard } from './homeConfigStorage'

/** Resolve the target item (note / tag / smart view) for a home card. */
export function resolveHomeCardTarget(
  application: WebApplication,
  card: HomeCard,
): SNNote | SNTag | SmartView | undefined {
  return application.items.findItem(card.targetUuid)
}

/** Open a specific note (mirrors DashboardView.openNote / runQuickAction.openNote). */
async function openNote(application: WebApplication, note: SNNote): Promise<void> {
  application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
  await application.itemListController.selectItemUsingInstance(note, true)
  application.paneController.setPaneLayout(PaneLayout.Editing)
}

/** Select a tag / folder / smart view (mirrors runQuickAction.navigateToTag). */
async function navigateToTag(application: WebApplication, tag: SNTag | SmartView): Promise<void> {
  const location = isTag(tag) ? (tag.starred ? 'favorites' : 'all') : 'views'
  await application.navigationController.setSelectedTag(tag, location, { userTriggered: true })
}

/**
 * Execute a configured home card against the REAL app controllers.
 *
 * - note: select + open a specific note.
 * - tag:  navigate to a tag / folder / smart view.
 *
 * A card whose target no longer exists is a no-op (the grid also skips rendering it).
 */
export async function runHomeCard(application: WebApplication, card: HomeCard): Promise<void> {
  const target = resolveHomeCardTarget(application, card)
  if (!target) {
    return
  }

  if (card.kind === 'note') {
    if (isNote(target)) {
      await openNote(application, target)
    }
    return
  }

  // kind === 'tag'
  if (isTag(target) || target instanceof SmartView) {
    await navigateToTag(application, target as SNTag | SmartView)
  }
}

/** Open the note chosen as the home page (used by `note` mode). */
export async function openHomeNote(application: WebApplication, note: SNNote): Promise<void> {
  await openNote(application, note)
}

/** A sensible default icon per card kind, used when the user hasn't set one. */
export function defaultIconForCard(card: HomeCard): VectorIconNameOrEmoji {
  return card.kind === 'note' ? 'notes' : 'hashtag'
}

/** A derived label per card when the user hasn't set one. */
export function defaultLabelForCard(application: WebApplication, card: HomeCard): string {
  const target = resolveHomeCardTarget(application, card)
  const targetTitle = (target && 'title' in target ? (target as { title?: string }).title : undefined) || 'Untitled'
  return targetTitle
}
