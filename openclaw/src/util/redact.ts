// Redaction helpers for the audit log. Note bodies, raw API responses, and
// anything that looks like a token must never hit the audit file.

/**
 * Value-shaped credentials. Each pattern requires a separator or a distinctive
 * prefix so that ordinary prose ("tokenization is a technique") is left alone —
 * the key-based rules below are what catch credentials whose value looks
 * unremarkable.
 */
const TOKEN_PATTERNS: RegExp[] = [
  // Authorization header values. The canonical form has whitespace after the
  // scheme, which is exactly what the original pattern failed to match.
  /\b(?:bearer|basic)[\s:=]+[a-z0-9._~+/=-]{8,}/gi,
  // Vendor-prefixed keys: sk-..., pk_..., ghp_..., xoxb-..., tok_..., key-...
  /\b(?:sk|pk|tok|key|ghp|gho|ghu|ghs|ghr|xox[abprs]?)[-_][a-z0-9_-]{8,}/gi,
  // JSON Web Tokens — the header segment always begins "eyJ".
  /\beyJ[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}/gi,
];

export function redactToken(input: string): string {
  return TOKEN_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, "<redacted-token>"),
    input,
  );
}

export function redactPathText(input: string): string {
  return input
    .replace(
      /(^|[\s"'(=])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'`),;]+)/g,
      "$1<redacted-path>",
    )
    .replace(
      /(^|[\s"'(=])((?:~\/|\/(?!\/))[^\s"'`),;]+)/g,
      "$1<redacted-path>",
    );
}

export function redactSensitiveText(input: string): string {
  return redactPathText(redactToken(input));
}

/** Keys whose value is a note payload — summarised rather than stored. */
const PAYLOAD_KEYS = new Set(["body", "content", "text"]);
const PATH_KEYS = new Set([
  "directory",
  "filepath",
  "outputpath",
  "path",
  "root",
]);

/**
 * Keys whose value is a credential, matched exactly after normalisation.
 * `key` is exact-only on purpose: as a suffix it would also swallow innocuous
 * keys such as `monkey` and `keyboard`.
 */
const CREDENTIAL_KEYS = new Set([
  "apikey",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "key",
  "password",
  "passphrase",
  "secret",
  "session",
  "sessionid",
  "token",
]);

/**
 * Suffixes that make a compound key a credential: `accessToken`, `api_key`,
 * `clientSecret`, `sessionCookie`. Matching on the SUFFIX rather than any
 * substring is the deliberate tradeoff — it catches the compound names that
 * actually occur while leaving `tokenCount` and `tokenizer` untouched.
 */
const CREDENTIAL_KEY_SUFFIXES = [
  "apikey",
  "cookie",
  "credential",
  "passphrase",
  "password",
  "secret",
  "token",
];

/**
 * Lowercase, drop separators, and drop a trailing plural so that `api-key`,
 * `api_key`, `apiKey` and `apiKeys` all normalise to `apikey`.
 */
function normalizeKey(key: string): string {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return flat.endsWith("s") ? flat.slice(0, -1) : flat;
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (CREDENTIAL_KEYS.has(normalized)) return true;
  return CREDENTIAL_KEY_SUFFIXES.some(
    (suffix) =>
      normalized.length > suffix.length && normalized.endsWith(suffix),
  );
}

function isPathKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    PATH_KEYS.has(normalized) ||
    normalized.endsWith("directory") ||
    normalized.endsWith("filepath") ||
    normalized.endsWith("path") ||
    normalized.endsWith("root")
  );
}

const NOTE_SUMMARY_PATTERN = /^<note:[^>]+ (?:empty|\d+ chars)>$/;

export interface NoteRef {
  uuid?: string;
  title?: string;
}

export function noteSummary(
  content: string | undefined,
  ref: NoteRef = {},
): string {
  if (content && NOTE_SUMMARY_PATTERN.test(content)) return content;
  if (!content) return `<note:${ref.uuid ?? "unknown"} empty>`;
  const len = content.length;
  return `<note:${ref.uuid ?? "unknown"} ${len} chars>`;
}

/**
 * Redacts an object for the audit log. String values that look like tokens are
 * masked. Values keyed `body`, `content` or `text` are summarised. Values under
 * a credential-bearing key (`token`, `apiKey`, `authorization`, `password`, …)
 * are replaced wholesale regardless of their shape — a credential must not
 * survive merely because it does not look like one.
 */
export function redactForAudit<T>(value: T): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PAYLOAD_KEYS.has(k.toLowerCase())) {
        out[k] = typeof v === "string" ? noteSummary(v) : "<redacted>";
      } else if (isPathKey(k)) {
        out[k] = "<redacted-path>";
      } else if (isCredentialKey(k)) {
        // Wholesale, and without a length hint — unlike a note summary, the
        // length of a credential is itself worth withholding.
        out[k] = "<redacted-credential>";
      } else {
        out[k] = redactForAudit(v);
      }
    }
    return out;
  }
  return value;
}
