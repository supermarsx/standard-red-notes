import { describe, expect, test } from "vitest";
import {
  compareNotePosition,
  decodeNoteCursor,
  encodeNoteCursor,
  isAfterNoteCursor,
} from "../src/pagination.js";

describe("note cursor pagination", () => {
  test("round-trips an opaque stable position", () => {
    const encoded = encodeNoteCursor({
      updatedAtMs: 1_700_000_000_123,
      uuid: "note-b",
    });
    expect(encoded).not.toContain("note-b");
    expect(decodeNoteCursor(encoded)).toEqual({
      version: 1,
      updatedAtMs: 1_700_000_000_123,
      uuid: "note-b",
    });
  });

  test.each(["", "not-base64", Buffer.from("{}").toString("base64url")])(
    "rejects malformed cursor %j",
    (cursor) => {
      expect(() => decodeNoteCursor(cursor)).toThrow("invalid notes cursor");
    },
  );

  test("uses UUID as a deterministic tie breaker", () => {
    const notes = [
      { updatedAtMs: 200, uuid: "b" },
      { updatedAtMs: 300, uuid: "z" },
      { updatedAtMs: 200, uuid: "a" },
    ].sort(compareNotePosition);
    expect(notes.map((note) => note.uuid)).toEqual(["z", "a", "b"]);
    const cursor = decodeNoteCursor(
      encodeNoteCursor({ updatedAtMs: 200, uuid: "a" }),
    );
    expect(notes.filter((note) => isAfterNoteCursor(note, cursor))).toEqual([
      { updatedAtMs: 200, uuid: "b" },
    ]);
  });
});
