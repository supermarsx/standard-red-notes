import { describe, expect, test, vi } from "vitest";

await import("../src/polyfill.js");
const { SnjsBackedClient } = await import(
  "../src/snjs/SnjsBackedClient.js"
);

function fixture() {
  const allowed = { uuid: "allowed-tag", title: "Allowed" };
  const denied = { uuid: "denied-tag", title: "Denied" };
  const visible = {
    uuid: "visible-note",
    title: "Visible",
    text: "body",
    created_at: new Date("2025-01-01T00:00:00Z"),
    updated_at: new Date("2025-01-02T00:00:00Z"),
  };
  const hidden = {
    ...visible,
    uuid: "hidden-note",
    title: "Hidden",
  };
  const visibleVault = {
    uuid: "visible-vault",
    name: "Visible vault",
    isSharedVaultListing: () => false,
  };
  const hiddenVault = {
    uuid: "hidden-vault",
    name: "Hidden vault",
    isSharedVaultListing: () => false,
  };
  const relations = new Map<unknown, any[]>([
    [visible, [allowed, denied]],
    [hidden, [denied]],
  ]);
  const sync = vi.fn(async () => undefined);
  const app = {
    items: {
      getDisplayableNotes: () => [visible, hidden],
      getDisplayableTags: () => [allowed, denied],
      getSortedTagsForItem: (note: unknown) => relations.get(note) ?? [],
    },
    vaults: {
      getItemVault: (item: unknown) =>
        item === visible
          ? visibleVault
          : item === hidden
            ? hiddenVault
            : undefined,
      getVaults: () => [visibleVault, hiddenVault],
    },
    mutator: {
      unlinkItems: vi.fn(async (tag: any, note: unknown) => {
        relations.set(
          note,
          (relations.get(note) ?? []).filter(
            (candidate) => candidate.uuid !== tag.uuid,
          ),
        );
      }),
      addTagToNote: vi.fn(async (note: unknown, tag: any) => {
        relations.set(note, [...(relations.get(note) ?? []), tag]);
      }),
      changeItem: vi.fn(async () => undefined),
    },
  };
  const headless = {
    app,
    sync,
    isSignedIn: () => true,
  } as any;
  const client = new SnjsBackedClient(headless, {
    allowWrites: true,
    baseUrl: "http://127.0.0.1",
    allowedTagUuids: [allowed.uuid],
  });
  return { client, app, allowed, denied, visible };
}

describe("exact advisory tag scope", () => {
  test("filters notes and tags by exact UUID", async () => {
    const { client, allowed } = fixture();
    await expect(client.listNotes(20)).resolves.toMatchObject({
      notes: [{ uuid: "visible-note" }],
    });
    await expect(client.listTags()).resolves.toEqual([
      { uuid: allowed.uuid, title: allowed.title },
    ]);
    await expect(client.readNote("hidden-note")).rejects.toThrow(
      "note not found",
    );
  });

  test("rejects changing an out-of-scope tag", async () => {
    const { client, denied, app } = fixture();
    await expect(
      client.applyTags("visible-note", { add: [], remove: [denied.uuid] }),
    ).rejects.toThrow("outside the advisory token scope");
    expect(app.mutator.unlinkItems).not.toHaveBeenCalled();
  });

  test("fails before mutation when removing the final scoped tag", async () => {
    const { client, allowed, app } = fixture();
    await expect(
      client.applyTags("visible-note", {
        add: [],
        remove: [allowed.uuid],
      }),
    ).rejects.toThrow("would leave the note outside");
    expect(app.mutator.unlinkItems).not.toHaveBeenCalled();
  });

  test("reports explicitly that the boundary is not cryptographic", () => {
    const { client, allowed } = fixture();
    expect(client.accountStatus().tagScope).toEqual({
      restricted: true,
      enforcement: "client-side-advisory",
      cryptographic: false,
      tagUuids: [allowed.uuid],
    });
    expect(client.accountStatus().vaultCount).toBe(1);
  });

  test("blocks account-wide exports that would bypass advisory filtering", async () => {
    const { client } = fixture();
    await expect(
      client.createEncryptedExport({
        outputPath: "C:\\not-reached.json",
        overwrite: false,
      }),
    ).rejects.toThrow("tag filtering is not a cryptographic boundary");
  });

  test("normalizes malformed timestamps to a finite deterministic cursor value", async () => {
    const { client, visible } = fixture();
    (visible as any).updated_at = "not-a-date";
    (visible as any).created_at = undefined;
    await expect(client.listNotes(1)).resolves.toMatchObject({
      notes: [{ updatedAt: "1970-01-01T00:00:00.000Z" }],
    });
  });
});
