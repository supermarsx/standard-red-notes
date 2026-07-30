const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;

export interface NoteCursor {
  version: 1;
  updatedAtMs: number;
  uuid: string;
}

export function encodeNoteCursor(cursor: Omit<NoteCursor, "version">): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      t: cursor.updatedAtMs,
      u: cursor.uuid,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeNoteCursor(value: string): NoteCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("invalid notes cursor");
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.v !== CURSOR_VERSION ||
      typeof decoded.t !== "number" ||
      !Number.isSafeInteger(decoded.t) ||
      decoded.t < 0 ||
      typeof decoded.u !== "string" ||
      decoded.u.length === 0 ||
      decoded.u.length > 128
    ) {
      throw new Error("invalid shape");
    }
    return {
      version: CURSOR_VERSION,
      updatedAtMs: decoded.t,
      uuid: decoded.u,
    };
  } catch {
    throw new Error("invalid notes cursor");
  }
}

export function compareNotePosition(
  a: { updatedAtMs: number; uuid: string },
  b: { updatedAtMs: number; uuid: string },
): number {
  if (a.updatedAtMs !== b.updatedAtMs) {
    return b.updatedAtMs - a.updatedAtMs;
  }
  return a.uuid.localeCompare(b.uuid);
}

export function isAfterNoteCursor(
  note: { updatedAtMs: number; uuid: string },
  cursor: NoteCursor,
): boolean {
  return (
    note.updatedAtMs < cursor.updatedAtMs ||
    (note.updatedAtMs === cursor.updatedAtMs && note.uuid > cursor.uuid)
  );
}
