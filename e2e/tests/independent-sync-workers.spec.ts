import { test, expect, type Page } from '@playwright/test'
import { waitForSocketReady as ready } from '../helpers/socket-readiness'
import {
  createAndPushNote,
  freshAccount,
  noteTextsByTitle,
  openFreshContext,
  registerAccount,
  signIn,
  syncUntilQuiescent,
  waitForApplicationReady,
} from '../helpers/sync'

async function rounds(page: Page) {
  return page.evaluate(
    () =>
      (window as any).mainApplicationGroup.primaryApplication._webSocketSyncTransport.laneDegradationLedger
        .syncRoundCounts,
  )
}

async function drained(page: Page) {
  const result = await syncUntilQuiescent(page)
  expect(result.quiescent, JSON.stringify(result)).toBe(true)
}

async function closeDefaultEditors(page: Page) {
  // Account-worker isolation: startup selects the same dated note in both tabs.
  // Leaving it open also starts a separate collaborative saver election, whose
  // follower must retain dirty state until a room acknowledgement arrives.
  // Finish the real durable handover before closing; never clear dirty items or
  // bypass the upload policy. The next scenario exercises concurrent editors.
  await page.evaluate(async () => {
    const app = (window as any).mainApplicationGroup.primaryApplication
    const group = app.itemControllerGroup
    for (const controller of [...group.itemControllers]) {
      await group.closeItemControllerAfterSaving(controller, () => true)
    }
  })
  await expect(page.locator('#super-editor-content:visible')).toHaveCount(0)
  await drained(page)
}

test('independent workers in one profile both save over sockets and survive a sibling closing', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  const account = freshAccount()
  await page.goto(baseURL ?? '/')
  await waitForApplicationReady(page)
  await registerAccount(page, account)
  await ready(page)
  await closeDefaultEditors(page)

  const sibling = await context.newPage()
  // Real dedicated-worker fallback: no replacement of the worker, journal,
  // application transport, authentication, or socket implementation.
  await sibling.addInitScript(() => {
    Object.defineProperty(window, 'SharedWorker', { value: undefined })
  })
  await sibling.goto(baseURL ?? '/')
  await waitForApplicationReady(sibling)
  await ready(sibling)
  await closeDefaultEditors(sibling)
  const baseline = await Promise.all([rounds(page), rounds(sibling)])
  const titles = [`parallel-a-${Date.now()}`, `parallel-b-${Date.now()}`]
  await Promise.all([
    createAndPushNote(page, titles[0], 'first independent worker'),
    createAndPushNote(sibling, titles[1], 'second independent worker'),
  ])
  for (const [i, tab] of [page, sibling].entries()) {
    await drained(tab)
    const actual = await rounds(tab)
    expect(actual.socket).toBeGreaterThan(baseline[i].socket)
    expect(actual.http).toBe(baseline[i].http)
    expect(actual.failed).toBe(baseline[i].failed)
  }
  await page.close()
  await sibling.reload()
  await waitForApplicationReady(sibling)
  await ready(sibling)
  await closeDefaultEditors(sibling)
  await drained(sibling)

  const reader = await openFreshContext(browser, baseURL)
  try {
    await signIn(reader.page, account)
    await drained(reader.page)
    expect(await noteTextsByTitle(reader.page, titles[0])).toEqual(['first independent worker'])
    expect(await noteTextsByTitle(reader.page, titles[1])).toEqual(['second independent worker'])
  } finally {
    await reader.context.close()
  }
})

async function selectEditableNote(page: Page, title: string) {
  await page.locator('input[placeholder="Search..."]:visible').fill(title)
  await page
    .locator('.content-list-item')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()
    .click()
  await expect(page.locator('#super-editor-content:visible')).toHaveAttribute('contenteditable', 'true', {
    timeout: 10_000,
  })
}

async function createCollaborativeNote(page: Page, title: string, sharedVaultUuid: string) {
  return page.evaluate(
    async ({ title, sharedVaultUuid }) => {
      const app = (window as any).mainApplicationGroup.primaryApplication
      const text = JSON.stringify({
        root: {
          type: 'root',
          version: 1,
          format: '',
          indent: 0,
          direction: 'ltr',
          children: [
            {
              type: 'paragraph',
              version: 1,
              format: '',
              indent: 0,
              direction: 'ltr',
              children: [
                {
                  type: 'text',
                  version: 1,
                  detail: 0,
                  format: 0,
                  mode: 'normal',
                  style: '',
                  text: 'Original text',
                },
              ],
            },
          ],
        },
      })
      const note = await app.mutator.insertItem(
        app.items.createTemplateItem('Note', {
          title,
          text,
          references: [],
          noteType: 'super',
          editorIdentifier: 'com.standardnotes.super-editor',
        }),
      )
      await app.sync.sync({ awaitAll: true })
      const vault = app.vaults.getVaults().find((v: any) => v.sharing?.sharedVaultUuid === sharedVaultUuid)
      const result = await app.vaults.moveItemToVault(vault, note)
      if (result.isFailed()) throw new Error('Fixture note could not enter its shared vault')
      await app.sync.sync({ awaitAll: true })
      return note.uuid as string
    },
    { title, sharedVaultUuid },
  )
}

test('a retained note in another tab does not pause a new room; independent editors share and persist changes', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  const account = freshAccount()
  const title = `parallel-room-${Date.now()}`
  await page.goto(baseURL ?? '/')
  await waitForApplicationReady(page)
  await registerAccount(page, account)
  await ready(page)
  const vaultUuid = await page.evaluate(async () => {
    const app = (window as any).mainApplicationGroup.primaryApplication
    const vault = await app.sharedVaults.createSharedVault({
      name: 'Parallel rooms',
      description: '',
      iconString: 'safe-square',
      storagePreference: 'synced',
    })
    await app.sync.sync({ awaitAll: true })
    return vault.sharing.sharedVaultUuid as string
  })
  await createCollaborativeNote(page, `${title}-old`, vaultUuid)
  await selectEditableNote(page, `${title}-old`)

  const sibling = await context.newPage()
  await sibling.addInitScript(() => Object.defineProperty(window, 'SharedWorker', { value: undefined }))
  await sibling.goto(baseURL ?? '/')
  await waitForApplicationReady(sibling)
  await ready(sibling)
  const noteUuid = await createCollaborativeNote(sibling, title, vaultUuid)
  await selectEditableNote(sibling, title)
  expect(
    await sibling.evaluate(() => (window as any).mainApplicationGroup.primaryApplication.syncSaveLane.usable),
  ).toBe(true)

  const peer = await context.newPage()
  await peer.addInitScript(() => Object.defineProperty(window, 'SharedWorker', { value: undefined }))
  await peer.goto(baseURL ?? '/')
  await waitForApplicationReady(peer)
  await ready(peer)
  await selectEditableNote(peer, title)
  // Sample the actual DOM throughout multiple fence-renewal intervals. This
  // catches the five-second toolbar/read-only flicker that a READY check misses.
  await peer.evaluate(() => {
    const state = { samples: 0, readOnly: 0 }
    ;(window as any).__editorSamples = state
    ;(window as any).__editorSampler = setInterval(() => {
      const root = [...document.querySelectorAll<HTMLElement>('#super-editor-content')].find(
        (e) => e.getBoundingClientRect().width > 0,
      )
      state.samples++
      if (root?.contentEditable !== 'true') state.readOnly++
    }, 50)
  })
  const marker = ` COLLABORATOR_${Date.now()}`
  const editor = peer.locator('#super-editor-content:visible')
  await editor.click()
  await peer.keyboard.press('Control+End')
  await peer.keyboard.type(marker)
  await expect(sibling.locator('#super-editor-content:visible')).toContainText(marker.trim())
  await expect
    .poll(async () => peer.evaluate(() => (window as any).__editorSamples.samples), { timeout: 25_000 })
    .toBeGreaterThan(400)
  const samples = await peer.evaluate(() => {
    clearInterval((window as any).__editorSampler)
    return (window as any).__editorSamples
  })
  expect(samples.readOnly).toBe(0)
  expect(
    await sibling.evaluate(
      (uuid) =>
        Boolean(
          (
            window as any
          ).mainApplicationGroup.primaryApplication._webSocketSyncTransport.options.getCollaborationSaveFence(uuid),
        ),
      noteUuid,
    ),
  ).toBe(true)
  const handoffStarted = Date.now()
  await sibling.close()
  await peer.waitForFunction(
    (uuid) =>
      Boolean(
        (
          window as any
        ).mainApplicationGroup.primaryApplication._webSocketSyncTransport.options.getCollaborationSaveFence(uuid),
      ),
    noteUuid,
    { timeout: 10_000 },
  )
  await expect(editor).toHaveAttribute('contenteditable', 'true', {
    timeout: 10_000,
  })
  expect(Date.now() - handoffStarted).toBeLessThan(10_000)
  const afterHandoff = ` AFTER_HANDOFF_${Date.now()}`
  await editor.click()
  await peer.keyboard.press('Control+End')
  await peer.keyboard.type(afterHandoff)
  await expect(editor).toContainText(afterHandoff.trim())
  await peer.waitForFunction(
    ({ uuid, marker }) => {
      const note = (window as any).mainApplicationGroup.primaryApplication.items.findItem(uuid)
      return note?.dirty === false && note.text.includes(marker)
    },
    { uuid: noteUuid, marker: afterHandoff },
    { timeout: 10_000 },
  )
  await drained(peer)

  const reader = await openFreshContext(browser, baseURL)
  try {
    await signIn(reader.page, account)
    await drained(reader.page)
    const texts = await noteTextsByTitle(reader.page, title)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(marker.trim())
    expect(texts[0]).toContain(afterHandoff.trim())
    expect(await noteTextsByTitle(reader.page, `${title}-old`)).toHaveLength(1)
  } finally {
    await reader.context.close()
  }
})
