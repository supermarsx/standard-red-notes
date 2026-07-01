import { expect, test } from '@playwright/test'

/**
 * Standard Red Notes (last-edit-loss fix) — browser-only end-to-end coverage.
 *
 * The Super editor debounces its document serialize by 350ms (createFlushableDebounce)
 * IN FRONT of the 700ms sync debounce. For up to ~1s a freshly typed edit lives ONLY in
 * those timer closures — it is NOT yet "dirty", so getDirtyItems()/syncInProgress safety
 * gates cannot see it and it was silently dropped on note-switch and logout.
 *
 * These flows exercise the two fully-fixable lifecycle boundaries against the real app:
 *   1. NOTE-SWITCH: type in note A, switch to B within the 350ms debounce window, switch
 *      back to A, and assert A's edit persisted (ItemGroupController flushes + awaits the
 *      outgoing editor's pending save before deiniting it).
 *   2. LOGOUT: type, then sign out within the debounce window, and assert the edit
 *      survived (ConfirmSignoutModal flushes + drains pending saves before signOut, so
 *      the edit is dirtied + persisted before clearAllData runs).
 *
 * NOTE: there is no Playwright runner wired up in this repo yet; the parent harness will
 * provide the runner/config and rebuild. Selectors below target stable ids/aria labels
 * used by the web app (NoteView title input, ConfirmSignoutModal). Adjust the BASE_URL /
 * sign-in helper to the harness's test fixture as needed.
 */

const BASE_URL = process.env.SN_E2E_BASE_URL ?? 'http://localhost:3000'

const SUPER_EDITOR_SELECTOR = '#blocks-editor [contenteditable="true"]'
const NOTE_TITLE_INPUT = '#note-title-editor'

/**
 * Helpers are intentionally thin and resilient. The harness is expected to land the app
 * in a signed-in (or offline) workspace; if a sign-in screen is shown, plug the test
 * account in here.
 */
async function createSuperNote(page: import('@playwright/test').Page, title: string) {
  await page.goto(BASE_URL)
  // Create a new note and switch it to the Super editor. The exact controls vary with
  // the harness fixture; these are the stable entry points.
  await page.getByRole('button', { name: /create a new note/i }).click()
  await page.fill(NOTE_TITLE_INPUT, title)
  // Change editor -> Super.
  await page.getByRole('button', { name: /change note type|change editor/i }).click()
  await page.getByText(/super/i).first().click()
  await page.waitForSelector(SUPER_EDITOR_SELECTOR)
}

async function typeIntoSuper(page: import('@playwright/test').Page, text: string) {
  const editor = page.locator(SUPER_EDITOR_SELECTOR)
  await editor.click()
  await editor.type(text, { delay: 0 })
}

async function openNoteByTitle(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: title }).first().click()
}

test.describe('Super editor — last-edit-loss at lifecycle boundaries', () => {
  test('note-switch within the 350ms debounce window does not drop the edit', async ({ page }) => {
    await createSuperNote(page, 'Note A')
    await createSuperNote(page, 'Note B')

    // Open A, type, and switch to B IMMEDIATELY (well within 350ms) so the serialize is
    // still mid-debounce when the switch tears A's editor down.
    await openNoteByTitle(page, 'Note A')
    await typeIntoSuper(page, 'edit-in-A-before-switch')
    await openNoteByTitle(page, 'Note B')

    // Come back to A; the flush-before-deinit must have persisted the edit.
    await openNoteByTitle(page, 'Note A')
    await expect(page.locator(SUPER_EDITOR_SELECTOR)).toContainText('edit-in-A-before-switch')

    // Reload to prove it reached local storage, not just in-memory state.
    await page.reload()
    await openNoteByTitle(page, 'Note A')
    await expect(page.locator(SUPER_EDITOR_SELECTOR)).toContainText('edit-in-A-before-switch')
  })

  test('logout within the debounce window flushes + persists the edit before clearAllData', async ({ page }) => {
    await createSuperNote(page, 'Logout Note')
    await openNoteByTitle(page, 'Logout Note')
    await typeIntoSuper(page, 'edit-before-logout')

    // Trigger sign-out immediately, while the edit is still mid-debounce.
    await page.getByRole('button', { name: /account menu|account/i }).click()
    await page.getByRole('button', { name: /sign out/i }).first().click()
    // ConfirmSignoutModal: confirm. The confirm handler flushes + awaits pending saves
    // BEFORE calling signOut.
    await page.getByRole('button', { name: /^sign out$|delete workspace/i }).click()

    // Sign back in (harness fixture) and assert the edit survived.
    // The exact re-auth depends on the fixture; the key assertion is that the persisted
    // note still carries the mid-debounce edit.
    await page.waitForLoadState('networkidle')
    await openNoteByTitle(page, 'Logout Note')
    await expect(page.locator(SUPER_EDITOR_SELECTOR)).toContainText('edit-before-logout')
  })
})
