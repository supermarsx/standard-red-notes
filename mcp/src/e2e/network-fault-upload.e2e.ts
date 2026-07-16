import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  check,
  cleanup,
  finish,
  freshAccount,
  SERVER,
  serverUp,
} from "./helpers.js";
import { bootstrapHeadlessApp, type HeadlessApp } from "../snjs/bootstrap.js";
import { SnjsBackedClient } from "../snjs/SnjsBackedClient.js";

// NETWORK FAULT MID-UPLOAD (t44-e4 #3).
//
// Data-assurance question: if the network drops while a client is uploading dirty
// changes, does the client SILENTLY DROP those changes (mark them clean/lost), or
// does it RETAIN them locally and re-upload on reconnect with full convergence?
//
// The fault is injected at the CLIENT SEAM (a fetch interceptor that rejects every
// request to the sync server), so it exercises the exact "request failed" path
// WITHOUT touching the server — nothing here can disturb another executor's stack.
// We assert: (a) dirty items are retained through the failure, (b) the server
// never received them during the outage (a device that syncs during the outage
// does NOT see them), (c) on reconnect a second device converges on every change.

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const dirtyCount = (app: HeadlessApp): number =>
  (app.app.items.getDirtyItems?.() ?? []).length;

// Client-side network fault: reject any fetch aimed at the sync origin while the
// flag is on; pass everything else straight through. This is a HARNESS shim (the
// spec's own global), not a product-code change.
const realFetch = globalThis.fetch;
let faultActive = false;
const serverHost = new URL(SERVER).host;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (faultActive && String(url).includes(serverHost)) {
    return Promise.reject(
      new TypeError("injected network fault: fetch failed"),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log("SKIP: server not reachable on", SERVER);
    process.exit(0);
  }

  // Device A: a clean synced baseline.
  const A = await freshAccount();
  const appA = A.app.app;
  const clientA = new SnjsBackedClient(A.app, {
    allowWrites: true,
    baseUrl: SERVER,
  });
  const base = await clientA.createNote({
    title: "Base",
    body: "synced baseline",
    tags: [],
  });
  await A.app.sync();
  check("baseline note synced clean (nothing dirty)", dirtyCount(A.app) === 0);

  // Device B: same account, pulls the baseline. Used to prove the server never
  // received A's changes during the outage.
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "srn-netfault-B-"));
  const appB = await bootstrapHeadlessApp({
    serverUrl: SERVER,
    dataDir: dirB,
    password: A.password,
    syncIntervalMs: 0,
  });
  await appB.signIn(A.email, A.password);
  await appB.sync();
  const clientB = new SnjsBackedClient(appB, {
    allowWrites: true,
    baseUrl: SERVER,
  });
  check(
    "device B pulled the baseline note",
    (await clientB.listNotes(50)).notes.some((n) => n.uuid === base.uuid),
  );

  // === NETWORK FAULT ON — author dirty changes that cannot upload ===
  faultActive = true;
  // Edit the baseline note + author two new notes, all WITHOUT a successful sync.
  await appA.mutator.changeItem(
    appA.items
      .getDisplayableNotes()
      .find((n: { uuid: string }) => n.uuid === base.uuid),
    (m: { text: string }) => {
      m.text = "edited during outage";
    },
  );
  const newNote1 = await appA.mutator.createItem(
    (await import("@standardnotes/snjs")).default.ContentType.TYPES.Note,
    { title: "Outage-1", text: "authored during outage", references: [] },
    true,
  );
  const newNote2 = await appA.mutator.createItem(
    (await import("@standardnotes/snjs")).default.ContentType.TYPES.Note,
    { title: "Outage-2", text: "authored during outage", references: [] },
    true,
  );

  // Confirm the fault is genuinely injected: a raw request to the sync origin
  // must fail while it is active. (This makes the "dirty retained" result below
  // meaningful — it is measured under a real outage, not a no-op.)
  const blocked = await globalThis
    .fetch(`${SERVER}/healthcheck`)
    .then(() => false)
    .catch(() => true);
  check(
    "network fault genuinely blocks the sync origin (outage is real)",
    blocked === true,
  );

  // Attempt to sync several times during the outage. snjs handles a network error
  // by transitioning offline and RESOLVING sync() (it does not reject) — so we do
  // NOT assert a throw; we assert the load-bearing guarantee: no dirty item is
  // cleared / silently dropped while the upload cannot reach the server.
  for (let i = 0; i < 3; i++) {
    await A.app.sync().catch(() => {});
    await sleep(150);
  }
  check(
    "outage syncs did NOT silently clear dirty items (no false success)",
    dirtyCount(A.app) >= 3,
  );
  const dirtyUuids = new Set(
    (appA.items.getDirtyItems?.() ?? []).map((i: { uuid: string }) => i.uuid),
  );
  check(
    "the edited baseline note is STILL dirty (retained, not dropped)",
    dirtyUuids.has(base.uuid),
  );
  check(
    "outage-authored note 1 is STILL dirty (retained)",
    dirtyUuids.has(newNote1.uuid),
  );
  check(
    "outage-authored note 2 is STILL dirty (retained)",
    dirtyUuids.has(newNote2.uuid),
  );
  check(
    "all local changes survive the outage locally",
    appA.items
      .getDisplayableNotes()
      .some(
        (n: { uuid: string; text?: string }) =>
          n.uuid === base.uuid && n.text === "edited during outage",
      ),
  );

  // The server must NOT have received any of it: a device syncing now (fault lifted
  // for B only would require per-request targeting; instead lift fault, let B sync,
  // and assert B does NOT yet see A's changes — proving they never left A).
  faultActive = false;
  await appB.sync();
  const bNotesDuring = (await clientB.listNotes(100)).notes;
  check(
    "server never received the outage edit (device B does not see it yet)",
    !bNotesDuring.some((n) => n.uuid === newNote1.uuid) &&
      !bNotesDuring.some((n) => n.uuid === newNote2.uuid),
  );
  const bBase = await clientB.readNote(base.uuid).catch(() => undefined);
  check(
    "server still holds the pre-outage baseline body (edit did not leak)",
    bBase?.body === "synced baseline",
  );

  // === RECONNECT — A re-uploads the retained dirty items, B converges ===
  for (let i = 0; i < 20 && dirtyCount(A.app) > 0; i++) {
    await A.app.sync();
    await sleep(150);
  }
  check(
    "after reconnect device A uploaded everything (nothing dirty)",
    dirtyCount(A.app) === 0,
  );

  let converged = false;
  for (let i = 0; i < 25; i++) {
    await appB.sync();
    const notes = (await clientB.listNotes(200)).notes;
    const editArrived =
      (await clientB.readNote(base.uuid).catch(() => undefined))?.body ===
      "edited during outage";
    if (
      notes.some((n) => n.uuid === newNote1.uuid) &&
      notes.some((n) => n.uuid === newNote2.uuid) &&
      editArrived
    ) {
      converged = true;
      break;
    }
    await sleep(300);
  }
  check(
    "after reconnect device B converges on ALL retained changes (no loss)",
    converged,
  );

  await cleanup(appB, dirB);
  await cleanup(A.app, A.dataDir);
  finish();
}

main().catch((e) => {
  console.error("E2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
