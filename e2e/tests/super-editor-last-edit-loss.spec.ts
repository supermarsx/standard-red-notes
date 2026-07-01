import { test, expect, type Page } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/stress'

/**
 * REGRESSION GATE: "the Super editor must not lose the LAST edit on a rapid
 * note-switch / reload / logout."
 *
 * BACKGROUND (the bug): the Super (Lexical) editor serialize is debounced ~350ms,
 * and the resulting sync save is itself debounced ~700ms. So for ~1s after a
 * keystroke the edit lives ONLY inside the editor's debounce-timer closure — it is
 * NOT yet a "dirty" item the app can see. If, within that window, the user switches
 * notes (which deinits the outgoing note's controller) or logs out, the edit was
 * silently dropped.
 *
 * THE FIX (deterministic parts this spec proves):
 *  (a) NOTE-SWITCH: ItemGroupController.flushAndCloseItemController() now awaits the
 *      outgoing NoteViewController.flushAndAwaitPendingSave() BEFORE deinit — it
 *      flushes the editor's pending serialize (dirtying the item) and drains the
 *      in-flight local save. So an edit typed mid-debounce is persisted, not lost.
 *  (b) LOGOUT: ConfirmSignoutModal flushes + awaits every open note editor's pending
 *      save before sign-out.
 *
 * The beforeunload/reload-instantly case is INHERENTLY best-effort (you cannot await
 * an async IndexedDB write on unload), so this spec does NOT assert "type then
 * instantly reload survives". Instead it asserts (test 3) only the accurate-WARNING
 * part: a quick edit makes the unsaved-changes/dirty-pending signal become true.
 *
 * Notes are created locally via the live in-page snjs application (the same surface
 * the other e2e helpers use); no account/sign-in is needed — with no account a
 * "sync" is purely the local IndexedDB persistence pass.
 */

const APP_SHELL = '.main-ui-view, #footer-bar'
const SUPER_EDITABLE = '#super-editor-content'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Create a Super note with the given title; returns its uuid. Does NOT open it. */
async function createSuperNote(page: Page, title: string): Promise<string> {
  return page.evaluate(async (noteTitle) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')
    const template = app.items.createTemplateItem('Note', {
      title: noteTitle,
      text: '',
      references: [],
      noteType: 'super',
      editorIdentifier: 'com.standardnotes.super-editor',
    })
    const note = await app.mutator.insertItem(template)
    await app.sync.sync({ sourceDescription: 'last-edit-loss-seed' })
    return note.uuid as string
  }, title)
}

/**
 * Open a note by clicking its row in the notes list (the real user path). Each list
 * row carries `id={item.uuid}` (see NoteListItem.tsx), so #<uuid> is a stable, exact
 * selector. Then wait for the Super editor to mount + render.
 */
async function openNoteByClick(page: Page, uuid: string): Promise<void> {
  // Each note row carries id={item.uuid}; an [id="..."] attribute selector avoids
  // any need to CSS-escape the uuid (and is browser-agnostic).
  const row = page.locator(`.content-list-item[id="${uuid}"]`)
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  await row.click({ timeout: 15_000 })
  // During a switch the outgoing editor can still be mounted (and HIDDEN) for a beat,
  // so two #super-editor-content nodes can briefly coexist — wait for the VISIBLE one
  // (the active pane), not merely the first in DOM order.
  await activeEditable(page).waitFor({ state: 'visible', timeout: 20_000 })
  // Exactly one VISIBLE editor (the active pane); an outgoing hidden one is ignored.
  await expect.poll(() => activeEditable(page).count(), { timeout: 10_000 }).toBe(1)
}

/** The currently-visible Super editor (the active pane), ignoring an outgoing hidden one. */
function activeEditable(page: Page) {
  return page.locator(`${SUPER_EDITABLE}:visible`)
}

/** The on-disk serialized `text` of a note (the saved Lexical doc), via snjs. */
async function noteSavedText(page: Page, uuid: string): Promise<string> {
  return page.evaluate((u) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    const item = app?.items?.findItem(u)
    return (item?.text as string) ?? ''
  }, uuid)
}

/** Is this note currently a dirty item (needs-sync, not yet persisted/pushed)? */
async function noteIsDirty(page: Page, uuid: string): Promise<boolean> {
  return page.evaluate((u) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    return app.items.getDirtyItems().some((i: { uuid: string }) => i.uuid === u)
  }, uuid)
}

/** The app-wide unsaved-changes signal that drives the beforeunload warning. */
async function appHasPendingUnsavedChanges(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) return false
    if (app.sync.getSyncStatus().syncInProgress) return true
    if (app.items.getDirtyItems().length > 0) return true
    // Mirror hasPendingEditorDebounce: any open note controller mid-debounce.
    try {
      return app.itemControllerGroup.itemControllers.some(
        (c: { editorHasPendingChanges?: () => boolean }) => typeof c.editorHasPendingChanges === 'function' && c.editorHasPendingChanges(),
      )
    } catch {
      return false
    }
  })
}

/* eslint-enable @typescript-eslint/no-explicit-any */

async function focusEditorAndType(page: Page, text: string): Promise<void> {
  const editable = activeEditable(page)
  await editable.click()
  await page.keyboard.type(text)
}

test.describe('Super editor — last-edit loss', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(APP_SHELL).first()).toBeVisible({ timeout: 30_000 })
    await waitForApplicationReady(page, 60_000)
  })

  /**
   * TEST 1 — THE CORE DETERMINISTIC FIX (note-switch).
   *
   * Type a distinctive string into note A, then WITHIN ~300ms (before the 350ms
   * serialize debounce fires) switch to note B. The switch deinits A's controller —
   * pre-fix this dropped the in-debounce edit. The fix flushes + awaits A's save
   * before deinit. Re-open A: its editor (and its saved text) must contain the string.
   *
   * On the PRE-FIX build this assertion FAILS (the edit is gone). It must PASS now.
   */
  test('1) note-switch within the debounce window does NOT lose the last edit', async ({ page }) => {
    const token = `SWITCHKEEP${Date.now()}`

    const uuidA = await createSuperNote(page, `A-${Date.now()}`)
    const uuidB = await createSuperNote(page, `B-${Date.now()}`)

    await openNoteByClick(page, uuidA)
    await focusEditorAndType(page, token)

    // RAPID SWITCH: jump to B well inside the 350ms serialize debounce, so the edit
    // is still only in A's debounce-timer closure (not yet a dirty item) at switch.
    await page.waitForTimeout(150)
    await openNoteByClick(page, uuidB)

    // Re-open A. The deterministic fix flushed + awaited A's save during the switch,
    // so the string is persisted and rendered when A re-mounts.
    await openNoteByClick(page, uuidA)

    const editable = activeEditable(page)
    await expect(editable, 'A editor must still show the edit typed just before the rapid switch').toContainText(token, {
      timeout: 15_000,
    })

    const savedA = await noteSavedText(page, uuidA)
    expect(savedA, "A's saved (serialized) text must contain the typed token").toContain(token)

    // And B must NOT have stolen it (sanity: the edit went to the right note).
    const savedB = await noteSavedText(page, uuidB)
    expect(savedB, "B must not contain A's edit").not.toContain(token)
  })

  /**
   * TEST 2 — RELOAD SURVIVAL with adequate time (the normal save path still works).
   *
   * Type, then WAIT ~1.2s so BOTH debounces flush and the local IndexedDB save lands.
   * Reload. The edit must survive. Deterministic because we waited out the debounces.
   */
  test('2) an edit given time to flush survives a page reload', async ({ page }) => {
    const token = `RELOADKEEP${Date.now()}`

    const uuid = await createSuperNote(page, `R-${Date.now()}`)
    await openNoteByClick(page, uuid)
    await focusEditorAndType(page, token)

    // Let the 350ms serialize + ~700ms sync debounce flush and the IDB write land.
    await page.waitForTimeout(1200)
    await expect.poll(() => noteSavedText(page, uuid), { timeout: 10_000 }).toContain(token)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator(APP_SHELL).first()).toBeVisible({ timeout: 30_000 })
    await waitForApplicationReady(page, 60_000)

    // After reload the note loads from IndexedDB; with lazy-decrypt its `text` may
    // arrive a beat after isLaunched(), so poll rather than read once.
    await expect
      .poll(() => noteSavedText(page, uuid), { timeout: 20_000 })
      .toContain(token)

    await openNoteByClick(page, uuid)
    await expect(activeEditable(page), 'reopened note must render the persisted edit').toContainText(token, {
      timeout: 15_000,
    })
  })

  /**
   * TEST 3 — ACCURATE UNSAVED-CHANGES WARNING for the unload case (best-effort path).
   *
   * We do NOT assert that an instant hard-reload survives (that race is inherently
   * best-effort). We assert only the accurate-warning part: right after a quick edit —
   * while it is still mid-debounce and NOT yet a dirty item — the app-wide
   * unsaved-changes signal (which drives the beforeunload prompt) is TRUE, because the
   * fix added a pending-editor-debounce check. So the user IS warned before leaving.
   */
  test('3) a quick edit makes the unsaved-changes warning signal true (mid-debounce)', async ({ page }) => {
    const token = `WARNCHECK${Date.now()}`

    const uuid = await createSuperNote(page, `W-${Date.now()}`)
    await openNoteByClick(page, uuid)

    // Baseline: nothing pending after the seed sync settles.
    await expect.poll(() => appHasPendingUnsavedChanges(page), { timeout: 10_000 }).toBe(false)

    await focusEditorAndType(page, token)

    // IMMEDIATELY (still inside the 350ms serialize debounce) the edit is NOT yet a
    // dirty item — yet the warning signal must already be true via the pending-editor
    // debounce check the fix added. Poll briefly to avoid keystroke-timing flake.
    await expect
      .poll(() => appHasPendingUnsavedChanges(page), { timeout: 1_000, intervals: [25, 50, 100] })
      .toBe(true)

    // And once the debounces flush it remains pending as a real dirty item / save.
    await page.waitForTimeout(1200)
    await expect.poll(() => noteSavedText(page, uuid), { timeout: 10_000 }).toContain(token)
  })
})
