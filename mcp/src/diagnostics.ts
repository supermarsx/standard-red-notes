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
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .slice(0, 1_000);
}
