# MCP Support Plan

## SDK and Transport Baseline

- Use `@modelcontextprotocol/sdk` `1.29.0`, the latest version found during the dependency audit.
- The official TypeScript SDK documents `McpServer`, `StdioServerTransport`, and Streamable HTTP as the modern remote transport: https://ts.sdk.modelcontextprotocol.io/documents/server.html
- Start with stdio because it is local, simple to launch from desktop/dev tools, and avoids remote auth concerns while the permission model is built.

## Architecture

Standard Red Notes needs two MCP surfaces because notes are end-to-end encrypted.

### Local Client MCP

Runs on the user's machine after the client is unlocked.

- Can access decrypted note content through the app/SNJS service layer.
- Requires explicit user consent before exposing note search, note read, note write, file access, or vault operations.
- Should support stdio first, then localhost Streamable HTTP with host header validation.
- Logs every tool invocation locally.

### Server MCP

Runs beside the self-hosted server.

- Must not decrypt note bodies because the server should not have plaintext.
- Can expose encrypted item metadata, account status, server health, sync diagnostics, file storage status, revision counts, and admin tasks.
- Requires server auth, scoped tokens, rate limits, and audit logs before remote transport is enabled.

## Initial Tool Set

Local client tools:

- `notes.search` - search decrypted titles/body in the unlocked client.
- `notes.read` - read one decrypted note by UUID.
- `notes.create` - create a note with title, body, tags, and editor type.
- `notes.update` - update note body/title with conflict checks.
- `tags.list` - list tags and smart views.
- `tags.apply` - apply tags to notes.
- `files.attach` - attach a file to a note with size and MIME checks.
- `export.create` - produce encrypted or plaintext export after confirmation.

Server tools:

- `server.status` - health, version, database mode, file storage mode.
- `users.lookup` - admin lookup by username/email with redacted fields.
- `capabilities.status` - report included-feature mode, operational quotas, and user/admin capability scopes.
- `sync.item_metadata` - encrypted item counts, content types, last sync timestamps.
- `files.storage_status` - storage path, configured limits, byte usage.
- `revisions.summary` - revision counts and retention status.

## Permission Model

- Every tool has a scope: `read`, `write`, `files`, `admin`, or `export`.
- Local client write/export tools prompt before first use per session.
- Server tools require scoped service tokens.
- Dangerous operations need dry-run support before mutation.
- Tool responses must redact emails, tokens, secrets, and encrypted payloads unless explicitly requested by an admin scope.

## Implementation Slices

1. Ship the bootstrap MCP package with a status tool.
2. Add a local client adapter that can read unlocked app state without creating another plaintext cache.
3. Add read-only note search and note read tools.
4. Add write tools with optimistic conflict checks and confirmation hooks.
5. Add server-side status/admin tools.
6. Add Streamable HTTP only after auth, DNS rebinding protection, CORS, and audit logging are covered.
7. Add MCP integration tests with the official inspector and tool-level unit tests.

## Security Requirements

- No plaintext note content is written to logs.
- No server-side plaintext note access is introduced.
- Local MCP is disabled by default unless explicitly enabled.
- Remote MCP binds to localhost by default.
- Remote MCP exposed beyond localhost requires TLS, scoped auth, and admin opt-in.
