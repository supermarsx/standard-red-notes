import snjs from "@standardnotes/snjs";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HeadlessApp } from "./bootstrap.js";
import {
  compareNotePosition,
  decodeNoteCursor,
  encodeNoteCursor,
  isAfterNoteCursor,
} from "../pagination.js";
import {
  resolveAllowedInputFile,
  resolveAllowedOutputFile,
  writePrivateOutputFile,
} from "../security/filesystem.js";

const { ContentType } = snjs as unknown as Record<string, any>;

export interface NoteSummary {
  uuid: string;
  title: string;
  updatedAt: string;
}
export interface NoteSearchHit {
  uuid: string;
  title: string;
  snippet: string;
}
export interface FullNote {
  uuid: string;
  title: string;
  body: string;
  tags: string[];
  vault?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TagSummary {
  uuid: string;
  title: string;
}
export interface VaultSummary {
  uuid: string;
  name: string;
  shared: boolean;
}
export interface SnjsBackedClientOptions {
  allowWrites: boolean;
  baseUrl: string;
  /**
   * Exact tag UUIDs granted by an MCP token. This is deliberately only an
   * advisory client-side view filter: scoped tokens carry account items keys,
   * so the bridge still receives and decrypts the account before filtering.
   * It is NOT a cryptographic isolation boundary.
   */
  allowedTagUuids?: readonly string[];
  fileRoots?: readonly string[];
  exportRoots?: readonly string[];
  maxAttachmentBytes?: number;
  maxExportBytes?: number;
}

function iso(d: unknown): string {
  return new Date(validTime(d) ?? 0).toISOString();
}

function validTime(value: unknown): number | undefined {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

// A just-created item that hasn't round-tripped a server-assigned update stamp
// reports `updated_at` as epoch 0; fall back to `created_at` so callers get a
// meaningful timestamp.
function updatedAtIso(note: {
  updated_at?: unknown;
  created_at?: unknown;
}): string {
  return new Date(updatedAtMs(note)).toISOString();
}

function updatedAtMs(note: {
  updated_at?: unknown;
  created_at?: unknown;
}): number {
  const updated = validTime(note.updated_at);
  if (updated !== undefined && updated > 0) {
    return updated;
  }
  return validTime(note.created_at) ?? 0;
}

function clientErrorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const candidate = value as {
      message?: unknown;
      error?: { message?: unknown };
    };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
    if (typeof candidate.error?.message === "string") {
      return candidate.error.message;
    }
  }
  return fallback;
}

/**
 * Backs the MCP tool handlers with a real, decrypted snjs account. Mirrors the
 * method surface the handlers previously expected from the HTTP ServerClient,
 * but operates on locally-decrypted items and persists via E2E-encrypted sync.
 */
export class SnjsBackedClient {
  readonly allowWrites: boolean;
  readonly baseUrl: string;
  private readonly allowedTagUuids?: ReadonlySet<string>;
  private readonly fileRoots: readonly string[];
  private readonly exportRoots: readonly string[];
  private readonly maxAttachmentBytes: number;
  private readonly maxExportBytes: number;

  constructor(
    private readonly headless: HeadlessApp,
    opts: SnjsBackedClientOptions,
  ) {
    this.allowWrites = opts.allowWrites;
    this.baseUrl = opts.baseUrl;
    this.allowedTagUuids =
      opts.allowedTagUuids === undefined
        ? undefined
        : new Set(opts.allowedTagUuids);
    this.fileRoots = opts.fileRoots ?? [];
    this.exportRoots = opts.exportRoots ?? [];
    this.maxAttachmentBytes = opts.maxAttachmentBytes ?? 16 * 1024 * 1024;
    this.maxExportBytes = opts.maxExportBytes ?? 128 * 1024 * 1024;
  }

  private get app(): any {
    return this.headless.app;
  }

  private notes(): any[] {
    const notes = this.rawNotes();
    if (this.allowedTagUuids === undefined) {
      return notes;
    }
    return notes.filter((note: any) =>
      this.tagItemsForNote(note).some((tag) =>
        this.allowedTagUuids?.has(tag.uuid),
      ),
    );
  }

  private rawNotes(): any[] {
    return this.app.items.getDisplayableNotes();
  }

  private noteByUuid(uuid: string): any {
    const note = this.notes().find((n) => n.uuid === uuid);
    if (!note) {
      throw new Error(`note not found: ${uuid}`);
    }
    return note;
  }

  private rawNoteByUuid(uuid: string): any {
    const note = this.rawNotes().find((candidate) => candidate.uuid === uuid);
    if (!note) {
      throw new Error(`note not found: ${uuid}`);
    }
    return note;
  }

  private tagsForNote(note: any): string[] {
    return this.tagItemsForNote(note).map((t: any) => t.title);
  }

  private tagItemsForNote(note: any): any[] {
    const tags = this.app.items.getSortedTagsForItem(note) ?? [];
    if (this.allowedTagUuids === undefined) {
      return tags;
    }
    return tags.filter((tag: any) => this.allowedTagUuids?.has(tag.uuid));
  }

  private allTagItemsForNote(note: any): any[] {
    return this.app.items.getSortedTagsForItem(note) ?? [];
  }

  private ensureTagAllowed(tag: any): void {
    if (
      this.allowedTagUuids !== undefined &&
      !this.allowedTagUuids.has(tag.uuid)
    ) {
      throw new Error(`tag is outside the advisory token scope: ${tag.uuid}`);
    }
  }

  private ensureRetainsScopedTag(tags: readonly any[]): void {
    if (
      this.allowedTagUuids !== undefined &&
      !tags.some((tag) => this.allowedTagUuids?.has(tag.uuid))
    ) {
      throw new Error(
        "operation would leave the note outside the advisory token tag scope",
      );
    }
  }

  private requireWrites(tool: string): void {
    if (!this.allowWrites) {
      throw new Error(
        `Writes are disabled. Set STANDARD_RED_NOTES_ALLOW_WRITES=1 to enable ${tool}.`,
      );
    }
  }

  async listNotes(
    limit: number,
    cursorValue?: string,
  ): Promise<{ notes: NoteSummary[]; cursor?: string }> {
    await this.headless.sync();
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("notes limit must be an integer between 1 and 200");
    }
    const cursor = cursorValue ? decodeNoteCursor(cursorValue) : undefined;
    const positioned = this.notes()
      .map((note) => ({
        note,
        uuid: String(note.uuid),
        updatedAtMs: updatedAtMs(note),
      }))
      .sort(compareNotePosition)
      .filter((note) => !cursor || isAfterNoteCursor(note, cursor));
    const page = positioned.slice(0, limit);
    const notes = page.map(({ note: n }) => ({
      uuid: n.uuid,
      title: n.title ?? "",
      updatedAt: updatedAtIso(n),
    }));
    const last = page.at(-1);
    return {
      notes,
      ...(positioned.length > limit && last
        ? {
            cursor: encodeNoteCursor({
              updatedAtMs: last.updatedAtMs,
              uuid: last.uuid,
            }),
          }
        : {}),
    };
  }

  async searchNotes(
    query: string,
    limit: number,
  ): Promise<{ hits: NoteSearchHit[] }> {
    await this.headless.sync();
    const q = query.toLowerCase();
    const hits: NoteSearchHit[] = [];
    const ordered = this.notes()
      .map((note) => ({
        note,
        uuid: String(note.uuid),
        updatedAtMs: updatedAtMs(note),
      }))
      .sort(compareNotePosition)
      .map(({ note }) => note);
    for (const n of ordered) {
      const title = String(n.title ?? "");
      const text = String(n.text ?? "");
      const idx = `${title}\n${text}`.toLowerCase().indexOf(q);
      if (idx === -1) {
        continue;
      }
      const start = Math.max(0, idx - 30);
      const snippet = `${title}\n${text}`
        .slice(start, start + 160)
        .replace(/\s+/g, " ")
        .trim();
      hits.push({ uuid: n.uuid, title, snippet });
      if (hits.length >= limit) {
        break;
      }
    }
    return { hits };
  }

  async readNote(uuid: string): Promise<FullNote> {
    const note = this.noteByUuid(uuid);
    const vault = this.app.vaults.getItemVault(note);
    return {
      uuid: note.uuid,
      title: note.title ?? "",
      body: note.text ?? "",
      tags: this.tagsForNote(note),
      vault: vault?.name,
      createdAt: iso(note.created_at),
      updatedAt: updatedAtIso(note),
    };
  }

  // --- vaults ------------------------------------------------------------

  async listVaults(): Promise<VaultSummary[]> {
    await this.headless.sync();
    return this.visibleVaults().map((v: any) => ({
      uuid: v.uuid,
      name: v.name ?? "",
      shared: v.isSharedVaultListing?.() ?? false,
    }));
  }

  private visibleVaults(): any[] {
    let vaults = this.app.vaults.getVaults();
    if (this.allowedTagUuids !== undefined) {
      const visibleVaultUuids = new Set(
        this.notes()
          .map((note) => this.app.vaults.getItemVault(note)?.uuid)
          .filter(Boolean),
      );
      vaults = vaults.filter((vault: any) => visibleVaultUuids.has(vault.uuid));
    }
    return vaults;
  }

  async createVault(name: string, description?: string): Promise<VaultSummary> {
    this.requireWrites("vaults.create");
    if (this.allowedTagUuids !== undefined) {
      throw new Error(
        "vault creation is unavailable to a tag-scoped MCP token",
      );
    }
    const vault = await this.app.vaults.createRandomizedVault({
      name,
      description,
      iconString: "🔒",
    });
    await this.headless.sync();
    return {
      uuid: vault.uuid,
      name: vault.name ?? name,
      shared: vault.isSharedVaultListing?.() ?? false,
    };
  }

  private vaultByUuid(uuid: string): any {
    const vault = this.app.vaults.getVaults().find((v: any) => v.uuid === uuid);
    if (!vault) {
      throw new Error(`vault not found: ${uuid}`);
    }
    return vault;
  }

  private async resolveTag(title: string, vault?: any): Promise<any> {
    const matches = this.app.items
      .getDisplayableTags()
      .filter((tag: any) => tag.title === title)
      .filter((tag: any) => {
        const tagVault = this.app.vaults.getItemVault(tag);
        return vault ? tagVault?.uuid === vault.uuid : !tagVault;
      });
    if (this.allowedTagUuids !== undefined) {
      const allowed = matches.filter((tag: any) =>
        this.allowedTagUuids?.has(tag.uuid),
      );
      if (allowed.length !== 1) {
        throw new Error(
          allowed.length === 0
            ? `tag title is outside the advisory token scope: ${title}`
            : `tag title is ambiguous inside the advisory token scope: ${title}`,
        );
      }
      return allowed[0];
    }
    if (matches[0]) {
      return matches[0];
    }
    return this.app.mutator.createTagOrSmartView(title, vault);
  }

  private tagByUuid(uuid: string): any {
    const tag = this.app.items
      .getDisplayableTags()
      .find((candidate: any) => candidate.uuid === uuid);
    if (!tag) {
      throw new Error(`tag not found: ${uuid}`);
    }
    this.ensureTagAllowed(tag);
    return tag;
  }

  async createNote(input: {
    title: string;
    body: string;
    tags: string[];
    vault?: string;
  }): Promise<{ uuid: string; title: string }> {
    this.requireWrites("notes.create");
    if (this.allowedTagUuids !== undefined && input.tags.length === 0) {
      throw new Error(
        "a tag-scoped token must create notes with at least one allowed tag",
      );
    }
    const vault = input.vault ? this.vaultByUuid(input.vault) : undefined;
    const resolvedTags = await Promise.all(
      [...new Set(input.tags)].map((title) => this.resolveTag(title, vault)),
    );
    // needsSync MUST be true so the note is marked dirty and actually uploaded
    // on sync; otherwise it stays local-only (never persisted server-side, and
    // never triggers the items-changed realtime event).
    const note = await this.app.mutator.createItem(
      ContentType.TYPES.Note,
      { title: input.title, text: input.body, references: [] },
      true,
    );

    // A vault item may only link to items in the same vault, so move the note
    // into the vault BEFORE linking tags, and co-locate each tag in that vault.
    if (vault) {
      const moved = await this.app.vaults.moveItemToVault(
        vault,
        this.rawNoteByUuid(note.uuid),
      );
      if (moved?.isFailed?.()) {
        throw new Error(
          `failed to move note into vault: ${moved.getError?.() ?? "unknown"}`,
        );
      }
    }

    for (const resolvedTag of resolvedTags) {
      const linked = await this.app.mutator.addTagToNote(
        this.rawNoteByUuid(note.uuid),
        resolvedTag,
        false,
      );
      if (!linked) {
        throw new Error(
          `failed to add tag to note (vault mismatch): ${resolvedTag.uuid}`,
        );
      }
    }

    this.ensureRetainsScopedTag(
      this.allTagItemsForNote(this.rawNoteByUuid(note.uuid)),
    );
    await this.headless.sync();
    return { uuid: note.uuid, title: input.title };
  }

  async updateNote(
    uuid: string,
    patch: { title?: string; body?: string; tags?: string[] },
  ): Promise<{ uuid: string; updatedAt: string }> {
    this.requireWrites("notes.update");
    const note = this.noteByUuid(uuid);
    let desired: any[] | undefined;
    let current: any[] | undefined;
    let mutableCurrent: any[] | undefined;
    if (patch.tags !== undefined) {
      const vault = this.app.vaults.getItemVault(note);
      desired = await Promise.all(
        [...new Set(patch.tags)].map((title) => this.resolveTag(title, vault)),
      );
      current = this.allTagItemsForNote(note);
      mutableCurrent =
        this.allowedTagUuids === undefined
          ? current
          : current.filter((tag) => this.allowedTagUuids?.has(tag.uuid));
      const desiredIds = new Set(desired.map((tag) => tag.uuid));
      const retained = current
        .filter(
          (tag) =>
            !mutableCurrent?.some((mutable) => mutable.uuid === tag.uuid) ||
            desiredIds.has(tag.uuid),
        )
        .concat(
          desired.filter(
            (tag) => !current?.some((existing) => existing.uuid === tag.uuid),
          ),
        );
      this.ensureRetainsScopedTag(retained);
    }
    await this.app.mutator.changeItem(note, (mutator: any) => {
      if (patch.title !== undefined) {
        mutator.title = patch.title;
      }
      if (patch.body !== undefined) {
        mutator.text = patch.body;
      }
    });
    if (desired && current && mutableCurrent) {
      const fresh = this.noteByUuid(uuid);
      const desiredIds = new Set(desired.map((tag) => tag.uuid));
      for (const tag of mutableCurrent) {
        if (!desiredIds.has(tag.uuid)) {
          await this.app.mutator.unlinkItems(tag, fresh);
        }
      }
      const currentIds = new Set(current.map((tag) => tag.uuid));
      for (const tag of desired) {
        if (!currentIds.has(tag.uuid)) {
          const linked = await this.app.mutator.addTagToNote(fresh, tag, false);
          if (!linked) {
            throw new Error(
              `failed to add tag to note (vault mismatch): ${tag.uuid}`,
            );
          }
        }
      }
    }
    await this.headless.sync();
    const updated = this.noteByUuid(uuid);
    return { uuid, updatedAt: updatedAtIso(updated) };
  }

  async deleteNote(uuid: string): Promise<void> {
    this.requireWrites("notes.delete");
    const note = this.noteByUuid(uuid);
    await this.app.mutator.setItemToBeDeleted(note);
    await this.headless.sync();
  }

  async listTags(): Promise<TagSummary[]> {
    await this.headless.sync();
    return this.app.items
      .getDisplayableTags()
      .filter(
        (tag: any) =>
          this.allowedTagUuids === undefined ||
          this.allowedTagUuids.has(tag.uuid),
      )
      .map((t: any) => ({ uuid: t.uuid, title: t.title ?? "" }));
  }

  async applyTags(
    noteUuid: string,
    change: { add: readonly string[]; remove: readonly string[] },
  ): Promise<{ uuid: string; tags: TagSummary[] }> {
    this.requireWrites("tags.apply");
    const note = this.noteByUuid(noteUuid);
    const addIds = new Set(change.add);
    const removeIds = new Set(change.remove);
    for (const uuid of addIds) {
      if (removeIds.has(uuid)) {
        throw new Error(`tag cannot be added and removed together: ${uuid}`);
      }
    }

    const additions = [...addIds].map((uuid) => this.tagByUuid(uuid));
    const removals = [...removeIds].map((uuid) => this.tagByUuid(uuid));
    const current = this.allTagItemsForNote(note);
    const finalByUuid = new Map(current.map((tag) => [tag.uuid, tag]));
    for (const tag of removals) {
      finalByUuid.delete(tag.uuid);
    }
    for (const tag of additions) {
      finalByUuid.set(tag.uuid, tag);
    }
    this.ensureRetainsScopedTag([...finalByUuid.values()]);

    for (const tag of removals) {
      if (current.some((candidate) => candidate.uuid === tag.uuid)) {
        await this.app.mutator.unlinkItems(tag, note);
      }
    }
    for (const tag of additions) {
      if (!current.some((candidate) => candidate.uuid === tag.uuid)) {
        const linked = await this.app.mutator.addTagToNote(note, tag, false);
        if (!linked) {
          throw new Error(
            `failed to add tag to note (vault mismatch): ${tag.uuid}`,
          );
        }
      }
    }
    await this.headless.sync();
    return {
      uuid: noteUuid,
      tags: this.tagItemsForNote(this.noteByUuid(noteUuid)).map((tag) => ({
        uuid: tag.uuid,
        title: tag.title ?? "",
      })),
    };
  }

  async attachFile(input: {
    noteUuid: string;
    path: string;
    name?: string;
    mimeType: string;
  }): Promise<{
    uuid: string;
    noteUuid: string;
    name: string;
    mimeType: string;
    size: number;
  }> {
    this.requireWrites("files.attach");
    const note = this.noteByUuid(input.noteUuid);
    const allowed = await resolveAllowedInputFile(input.path, this.fileRoots);
    if (allowed.size < 1 || allowed.size > this.maxAttachmentBytes) {
      throw new Error(
        `attachment size must be between 1 and ${this.maxAttachmentBytes} bytes`,
      );
    }
    const handle = await fs.open(allowed.path, "r");
    let bytes: Uint8Array;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== allowed.size) {
        throw new Error("attachment changed while it was being opened");
      }
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    if (bytes.byteLength !== allowed.size) {
      throw new Error("attachment changed while it was being read");
    }

    const fileName = input.name?.trim() || path.basename(allowed.path);
    if (
      fileName.length > 255 ||
      fileName !== path.basename(fileName) ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw new Error("attachment name must be a safe basename");
    }
    if (
      input.mimeType.length > 255 ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
        input.mimeType,
      )
    ) {
      throw new Error("invalid attachment MIME type");
    }

    const files = this.app.files;
    const operation = await files.beginNewFileUpload(
      bytes.byteLength,
      this.app.vaults.getItemVault(note),
    );
    if (!operation || typeof operation.getProgress !== "function") {
      throw new Error(
        clientErrorMessage(operation, "failed to begin attachment upload"),
      );
    }
    const chunkSize = files.minimumChunkSize();
    let chunkId = 1;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const final = offset + chunkSize >= bytes.length;
      const error = await files.pushBytesForUpload(
        operation,
        bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
        chunkId++,
        final,
      );
      if (error) {
        throw new Error(
          clientErrorMessage(error, "failed to upload attachment bytes"),
        );
      }
    }
    const uuid = randomUUID();
    const file = await files.finishUpload(
      operation,
      { name: fileName, mimeType: input.mimeType },
      uuid,
    );
    if (!file || typeof file !== "object" || !("uuid" in file)) {
      throw new Error(
        clientErrorMessage(file, "failed to finalize attachment upload"),
      );
    }
    const associated = await this.app.mutator.associateFileWithNote(file, note);
    if (!associated) {
      await files.deleteFile(file).catch(() => undefined);
      throw new Error("failed to associate attachment with note");
    }
    await this.headless.sync();
    return {
      uuid,
      noteUuid: input.noteUuid,
      name: fileName,
      mimeType: input.mimeType,
      size: bytes.byteLength,
    };
  }

  async createEncryptedExport(input: {
    outputPath: string;
    overwrite: boolean;
  }): Promise<{ path: string; bytes: number; encrypted: true }> {
    if (this.allowedTagUuids !== undefined) {
      throw new Error(
        "account exports are unavailable to a tag-scoped MCP token because tag filtering is not a cryptographic boundary",
      );
    }
    const outputPath = await resolveAllowedOutputFile(
      input.outputPath,
      this.exportRoots,
    );
    const result = await this.app.createEncryptedBackupFile.execute({
      skipAuthorization: true,
    });
    if (result?.isFailed?.()) {
      throw new Error(
        `failed to create encrypted export: ${String(result.getError?.() ?? "unknown error")}`,
      );
    }
    const backup = result?.getValue?.() ?? result;
    const serialized = JSON.stringify(backup);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxExportBytes) {
      throw new Error(
        `encrypted export exceeds ${this.maxExportBytes} byte limit`,
      );
    }
    await writePrivateOutputFile(outputPath, serialized, input.overwrite);
    return { path: outputPath, bytes, encrypted: true };
  }

  async serverStatus(): Promise<{
    reachable: boolean;
    statusCode?: number;
    latencyMs: number;
  }> {
    const started = Date.now();
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, "")}/healthcheck`,
        { signal: AbortSignal.timeout(5_000) },
      );
      return {
        reachable: response.ok,
        statusCode: response.status,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { reachable: false, latencyMs: Date.now() - started };
    }
  }

  accountStatus(): {
    signedIn: boolean;
    writes: boolean;
    noteCount: number;
    tagCount: number;
    vaultCount: number;
    tagScope: {
      restricted: boolean;
      enforcement: "client-side-advisory";
      cryptographic: false;
      tagUuids?: string[];
    };
  } {
    return {
      signedIn: this.headless.isSignedIn(),
      writes: this.allowWrites,
      noteCount: this.notes().length,
      tagCount: this.app.items
        .getDisplayableTags()
        .filter(
          (tag: any) =>
            this.allowedTagUuids === undefined ||
            this.allowedTagUuids.has(tag.uuid),
        ).length,
      vaultCount: this.visibleVaults().length,
      tagScope: {
        restricted: this.allowedTagUuids !== undefined,
        enforcement: "client-side-advisory",
        cryptographic: false,
        ...(this.allowedTagUuids === undefined
          ? {}
          : { tagUuids: [...this.allowedTagUuids].sort() }),
      },
    };
  }
}
