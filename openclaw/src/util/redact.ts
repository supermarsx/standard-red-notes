// Redaction helpers for the audit log. Note bodies, raw API responses, and
// anything that looks like a token must never hit the audit file.

const TOKEN_RE = /(?:sk|pk|tok|key|bearer)[-_]?[a-z0-9_]{8,}/gi;

export function redactToken(input: string): string {
  return input.replace(TOKEN_RE, "<redacted-token>");
}

export interface NoteRef {
  uuid?: string;
  title?: string;
}

export function noteSummary(
  content: string | undefined,
  ref: NoteRef = {},
): string {
  if (!content) return `<note:${ref.uuid ?? "unknown"} empty>`;
  const len = content.length;
  return `<note:${ref.uuid ?? "unknown"} ${len} chars>`;
}

/**
 * Redacts an object for the audit log. String values that look like tokens
 * are masked. Values keyed `body`, `content`, `text`, or `password` are
 * replaced wholesale.
 */
export function redactForAudit<T>(value: T): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactToken(value);
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (
        lower === "body" ||
        lower === "content" ||
        lower === "text" ||
        lower === "password"
      ) {
        out[k] = typeof v === "string" ? noteSummary(v) : "<redacted>";
      } else {
        out[k] = redactForAudit(v);
      }
    }
    return out;
  }
  return value;
}
