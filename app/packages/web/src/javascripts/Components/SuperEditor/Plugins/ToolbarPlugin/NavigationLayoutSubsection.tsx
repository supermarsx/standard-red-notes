import { FunctionComponent } from 'react'
import { NavigationSettings, NoteLayout } from '../../Layout/layoutSettings'
import { NAVIGATION_LAYOUT_CHANGED_EVENT } from '../NavigationSidebarPlugin/NavigationSidebarPlugin'

type NavigationLayoutSubsectionProps = {
  navigation: NavigationSettings
  onChange: (patch: Partial<NavigationSettings>) => void
}

/**
 * The "Navigation" bordered subsection card inside the page-layout popover.
 *
 * Unlike its sibling subsections (Page numbers / Header / Footer) it is NOT a
 * paginated-export band — it toggles the on-screen document-outline sidebar and
 * the export mapper ignores `navigation` entirely. It is kept as its own small,
 * jest-mountable component (rather than inline JSX) so the popover's render path
 * is exercised directly in jsdom — the full ToolbarPlugin closes over deep editor
 * state and cannot be mounted — guarding against the subsection silently
 * vanishing (MEMORY: verify UI render paths; the Page group vanished twice).
 */
export const NavigationLayoutSubsection: FunctionComponent<NavigationLayoutSubsectionProps> = ({
  navigation,
  onChange,
}) => {
  return (
    <div className="border-border mt-3 rounded-md border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={navigation.visible}
          onChange={(event) => onChange({ visible: event.target.checked })}
        />
        Navigation sidebar
      </label>
      <p className="text-passive-1 mt-1 text-xs">
        Shows a live outline of headings and bookmarks beside the editor (on-screen only).
      </p>
      {navigation.visible && (
        <label className="text-passive-1 mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={navigation.showBookmarks}
            onChange={(event) => onChange({ showBookmarks: event.target.checked })}
          />
          Show bookmarks in the sidebar
        </label>
      )}
    </div>
  )
}

/**
 * Apply a Navigation-settings patch from the popover toggle: persist it through
 * the layout updater AND fire the DOM bridge event on the editor root so the live
 * NavigationSidebar re-syncs immediately. Shared by ToolbarPlugin's `setNavigation`
 * and exercised directly in the spec (the bridge dispatch is the contract the
 * sidebar listens on — see NAVIGATION_LAYOUT_CHANGED_EVENT).
 */
export function applyNavigationPatch(
  current: NavigationSettings,
  patch: Partial<NavigationSettings>,
  updateNoteLayout: (patch: Partial<NoteLayout>) => void,
  rootElement: HTMLElement | null,
): void {
  const next: NavigationSettings = { ...current, ...patch }
  updateNoteLayout({ navigation: next })
  rootElement?.dispatchEvent(new CustomEvent<NavigationSettings>(NAVIGATION_LAYOUT_CHANGED_EVENT, { detail: next }))
}
