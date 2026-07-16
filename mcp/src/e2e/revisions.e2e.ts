import {
  check,
  cleanup,
  finish,
  freshAccount,
  SERVER,
  serverUp,
  skip,
} from "./helpers.js";
import { SnjsBackedClient } from "../snjs/SnjsBackedClient.js";

// REVISIONS / HISTORY — live exercise of the revision use-cases.
//
// FINDING (reported, not fixed): against the live full-stack gateway at :3001 the
// client's revision endpoint `GET /v2/items/:uuid/revisions` (snjs
// RevisionManager -> RevisionApiService -> Paths.v2.listRevisions) returns HTTP
// 404 (Express "Cannot GET /items/<uuid>/revisions"), while other authed routes
// (e.g. /v1/sessions) return 200 on the same session. nginx.conf DOES proxy /v2/
// to the gateway, and RevisionsControllerV2 (@controller('/v2')) declares
// GET /items/:itemUuid/revisions — yet the route does not resolve, so listing,
// retrieving, restoring and deleting note revisions is UNREACHABLE via the API on
// this deployment. This breaks note history/restore. The failing check below is
// the evidence; the coordinator should queue an investigation of the gateway's
// v2 revisions route registration (do NOT fix from a test).
//
// Note on creation frequency (secondary): server-side revision creation is gated
// by `secondsFromLastUpdate >= revisionsFrequency` (UpdateExistingItem.ts:207-209),
// premium 300s / free 86400s. Included-mode accounts here carry a SECOND role
// beyond CORE_USER (printed below), so isFreeUser=false => 300s — a revision could
// accrue after a ~5min gap. That is moot while the list endpoint 404s.
//
// The read-only delete guard + transactional CopyRevisions idempotency were
// verified statically by t38-e5.

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!(await serverUp())) {
    console.log("SKIP: server not reachable on", SERVER);
    process.exit(0);
  }

  const A = await freshAccount();
  const appA = A.app.app;
  const client = new SnjsBackedClient(A.app, {
    allowWrites: true,
    baseUrl: SERVER,
  });

  const created = await client.createNote({
    title: "Revision Note",
    body: "v1",
    tags: [],
  });
  await A.app.sync();
  for (const body of ["v2", "v3", "v4"]) {
    await client.updateNote(created.uuid, { body });
    await A.app.sync();
    await sleep(1000);
  }
  await A.app.sync();

  const token = appA.sessions.getSession?.()?.accessToken?.value as string;

  // Diagnostic: the account's roles (drives isFreeUser -> revision frequency).
  try {
    const sres = await fetch(`${SERVER}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const sbody: any = await sres.json().catch(() => ({}));
    const roles = (sbody?.meta?.auth?.roles ?? []).map((r: any) => r?.name);
    console.log(
      "    account roles:",
      JSON.stringify(roles),
      "=> isFreeUser:",
      roles.length === 1 && roles[0] === "CORE_USER",
    );
  } catch {
    /* diagnostic only */
  }

  // Raw HTTP evidence for the endpoint reachability.
  const revUrl = `${SERVER}/v2/items/${created.uuid}/revisions`;
  const rawRes = await fetch(revUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  const rawBody = (await rawRes.text()).slice(0, 120);
  console.log(
    "    RAW GET /v2/items/:uuid/revisions ->",
    rawRes.status,
    JSON.stringify(rawBody),
  );

  // snjs client path (what the real app uses).
  const listRes = await appA.listRevisions.execute({ itemUuid: created.uuid });
  const listOk = !listRes?.isFailed?.();
  console.log(
    "    snjs listRevisions ok?",
    listOk,
    "err:",
    listOk ? "" : String(listRes?.getError?.() ?? ""),
  );

  // EVIDENCE of the reported product bug: the revisions endpoint must be reachable.
  check(
    "PRODUCT BUG (report): GET /v2/items/:uuid/revisions is reachable (not 404)",
    rawRes.status !== 404,
  );
  check(
    "PRODUCT BUG (report): snjs listRevisions succeeds (history retrievable)",
    listOk,
  );

  // A bogus revision uuid must still fail cleanly (not crash) — guard behaviour.
  const bogus = await appA.getRevision.execute({
    itemUuid: created.uuid,
    revisionUuid: "00000000-0000-0000-0000-000000000000",
  });
  check(
    "getRevision on a non-existent revision fails cleanly (no crash)",
    bogus?.isFailed?.() === true,
  );

  if (!listOk) {
    skip(
      "revision accrue/retrieve/restore/delete (live)",
      "revisions endpoint returns 404 on this stack (see reported product bug) — cannot list/get/restore/delete",
    );
    await cleanup(A.app, A.dataDir);
    finish();
    return;
  }

  // Reached only if the endpoint is fixed and a revision has accrued.
  const revisions = listRes.getValue() as any[];
  console.log("    revision count observed:", revisions.length);
  if (revisions.length === 0) {
    skip(
      "revision retrieve/restore/delete",
      "endpoint reachable but no revision accrued within the window (300s premium gate)",
    );
    await cleanup(A.app, A.dataDir);
    finish();
    return;
  }

  const sorted = [...revisions].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  );
  const oldest = sorted[0];
  const getRes = await appA.getRevision.execute({
    itemUuid: created.uuid,
    revisionUuid: oldest.uuid,
  });
  check("an older revision is retrievable and decrypts", !getRes.isFailed());
  if (!getRes.isFailed()) {
    const oldText = getRes.getValue()?.payload?.content?.text;
    const liveNote = appA.items
      .getDisplayableNotes()
      .find((n: any) => n.uuid === created.uuid);
    await appA.mutator.changeItem(liveNote, (m: any) => {
      m.text = oldText;
    });
    await A.app.sync();
    const restored = appA.items
      .getDisplayableNotes()
      .find((n: any) => n.uuid === created.uuid);
    check(
      "note reverted to the restored revision body",
      restored?.text === oldText,
    );
    const delRes = await appA.deleteRevision.execute({
      itemUuid: created.uuid,
      revisionUuid: oldest.uuid,
    });
    check("owner can delete their own revision", !delRes.isFailed());
  }

  await cleanup(A.app, A.dataDir);
  finish();
}

main().catch((e) => {
  console.error("E2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
