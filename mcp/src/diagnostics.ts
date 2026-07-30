export function redactDiagnosticMessage(
  error: unknown,
  secrets: readonly (string | undefined)[],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, "<redacted>");
    }
  }
  return message
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi,
      "$1<redacted>",
    )
    .replace(
      /\bBearer\s+(?=[^\s,;]{8,})(?=[^\s,;]*[0-9._~+/=-])[^\s,;]+/gi,
      "Bearer <redacted>",
    )
    .replace(
      /\b((?:x-api-key|api-key|x-auth-token|mcp[_-]http[_-]token|standard[_-]red[_-]notes[_-]mcp[_-]token|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi,
      "$1<redacted>",
    )
    .slice(0, 1_000);
}
