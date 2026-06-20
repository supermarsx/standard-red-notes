# srn-client

A command-line tool to manage a **Standard Red Notes** account against a
self-hosted server. It performs **real, end-to-end-encrypted note CRUD**: notes
are decrypted locally by an embedded headless [`@standardnotes/snjs`] client and
changes sync back to the server encrypted — exactly like the web/desktop app.

This is not a thin REST wrapper. It runs the actual Standard Notes protocol
(SRP sign-in, root-key derivation via argon2, items-key decryption) in Node,
reusing the same proven approach as the repo's MCP bridge (`mcp/`).

## Install / build

The package is standalone (it is **not** part of the Yarn workspace, so it does
not touch the app/server lockfiles). It resolves its dependencies
(`@standardnotes/snjs`, `@standardnotes/sncrypto-web`, `libsodium-wrappers-sumo`)
from the repo's root `node_modules`, which already contains them.

```bash
cd cli/srn-client
node esbuild.config.mjs      # bundles src -> dist/index.cjs
node dist/index.cjs --help
```

Run it anywhere with `node /path/to/cli/srn-client/dist/index.cjs <command>`, or
`npm link` / add `dist/index.cjs` (the `bin`) to your PATH as `srn-client`.

Requires Node 22+.

## Commands

| Command | Description |
| --- | --- |
| `login` | Sign in and store the session locally under `~/.srn` |
| `logout` | Clear the stored local session and keys |
| `whoami` | Show the active account and confirm the session is valid |
| `notes list [--limit N] [--json]` | List notes (uuid, updatedAt, title) |
| `notes get <uuid> [--json]` | Read a single note (title, text, tags, timestamps) |
| `notes create --title <t> [--text <body>] [--tag a,b]` | Create a note |
| `notes update <uuid> [--title <t>] [--text <body>] [--tag a,b]` | Update a note |
| `notes delete <uuid>` | Delete a note |
| `export [--out <file>] [--format json\|md]` | Export all notes (decrypted) |
| `import <file.json>` | Create notes from a JSON array of `{ title, text, tags? }` |
| `version` | Print the CLI version |
| `help` | Show help |

### login options

```
--server <url>       Server base URL (or $SRN_SERVER_URL)
--email <email>
--password <pw>      (or $SRN_PASSWORD — prefer the env var over shell history)
--mfa <code>         TOTP / 2FA code, if the account requires it
--server-key <key>   X-Shared-Server-Key gate value (or $SHARED_SERVER_ACCESS_KEY)
--register           Create a NEW account instead of signing in
```

## Examples

```bash
srn-client login --server http://localhost:3000 --email me@example.com --password 'secret'
srn-client notes create --title "Hello" --text "world" --tag inbox,ideas
srn-client notes list --limit 20
srn-client notes get 7d5e357d-ff7f-4a56-9470-94d830d904a4
srn-client export --out backup.json --format json
srn-client import backup.json
srn-client logout
```

## Configuration & security

- **Session storage.** `login` stores the snjs keychain (root-key material) and a
  persisted cookie jar under `~/.srn/data/<profile>/` (override the base dir with
  `$SRN_HOME`). The `~/.srn` directory is created with mode `0700` and
  `config.json`/keychain/cookies files with mode `0600` (POSIX; advisory on
  Windows). The server uses cookie-based sessions, so the cookie jar is persisted
  between one-shot invocations.
- **End-to-end encryption.** Note bodies are encrypted client-side; the server
  only ever stores ciphertext. Decryption happens locally in this CLI.
- **Shared server access key.** If your operator has enabled the optional
  server-wide access-key gate, pass `--server-key <key>` to `login` (or set
  `$SHARED_SERVER_ACCESS_KEY`). The key is sent as the `X-Shared-Server-Key`
  header on every request to the configured server origin (and only that origin).
  This is operator obfuscation/access-gating, **not** end-to-end security.
- **Secrets are never logged.** Passwords and the shared key are not printed.
  Prefer the `$SRN_PASSWORD` env var over `--password` to keep secrets out of
  shell history.

## How it works (crypto/protocol path)

The CLI embeds a headless snjs `SNApplication` backed by a file-based
`NodeDevice` (adapted from `mcp/src/snjs/NodeDevice.ts`) and `SNWebCrypto` (with a
libsodium-sumo shim so argon2/`crypto_pwhash` is available in Node). Sign-in,
sync, decryption, and item mutation all go through real snjs services — the same
blueprint as `mcp/src/snjs/bootstrap.ts` and `mcp/src/snjs/SnjsBackedClient.ts`.

[`@standardnotes/snjs`]: https://www.npmjs.com/package/@standardnotes/snjs
