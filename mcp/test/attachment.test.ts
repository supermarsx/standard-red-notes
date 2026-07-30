import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

await import("../src/polyfill.js");
const { SnjsBackedClient } = await import(
  "../src/snjs/SnjsBackedClient.js"
);

const temporaryDirectories: string[] = [];

async function setup(associate: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "srn-attach-"));
  temporaryDirectories.push(root);
  const inputPath = path.join(root, "input.txt");
  await fs.writeFile(inputPath, "attachment");
  const note = { uuid: "note-1" };
  const vault = { uuid: "vault-1" };
  const operation = { getProgress: () => ({ percentComplete: 0 }) };
  const file = { uuid: "file-1" };
  const files = {
    beginNewFileUpload: vi.fn(async () => operation),
    minimumChunkSize: () => 1024,
    pushBytesForUpload: vi.fn(async () => undefined),
    finishUpload: vi.fn(async () => file),
    deleteFile: vi.fn(async () => undefined),
  };
  const sync = vi.fn(async () => undefined);
  const app = {
    items: {
      getDisplayableNotes: () => [note],
      getSortedTagsForItem: () => [],
    },
    vaults: {
      getItemVault: () => vault,
    },
    files,
    mutator: {
      associateFileWithNote: vi.fn(async () => (associate ? file : undefined)),
    },
  };
  const client = new SnjsBackedClient(
    { app, sync, isSignedIn: () => true } as any,
    {
      allowWrites: true,
      baseUrl: "http://127.0.0.1",
      fileRoots: [root],
    },
  );
  return { client, inputPath, note, vault, operation, file, files, app, sync };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("file attachment vault invariants", () => {
  test("uploads in the target note vault before associating", async () => {
    const context = await setup(true);
    await context.client.attachFile({
      noteUuid: context.note.uuid,
      path: context.inputPath,
      mimeType: "text/plain",
    });
    expect(context.files.beginNewFileUpload).toHaveBeenCalledWith(
      10,
      context.vault,
    );
    expect(
      context.app.mutator.associateFileWithNote,
    ).toHaveBeenCalledWith(context.file, context.note);
    expect(context.files.deleteFile).not.toHaveBeenCalled();
  });

  test("fails and cleans up the uploaded file when association fails", async () => {
    const context = await setup(false);
    await expect(
      context.client.attachFile({
        noteUuid: context.note.uuid,
        path: context.inputPath,
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("failed to associate attachment with note");
    expect(context.files.deleteFile).toHaveBeenCalledWith(context.file);
    expect(context.sync).not.toHaveBeenCalled();
  });
});
