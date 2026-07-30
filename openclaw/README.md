# OpenClaw

OpenClaw is the Standard Red Notes command-line personal assistant. It connects
an Anthropic, OpenAI, Ollama, or Hermes model to a separately installed local
or remote Standard Red Notes MCP bridge and exposes `doctor`, one-shot `ask`,
and interactive `chat` commands.

## Release package

Tagged `srn-openclaw-v<semver>` releases contain one
`srn-openclaw-<version>-node-any.tgz` npm package. OpenClaw is platform-neutral
JavaScript, so the release does not relabel it as six native binaries. The
package supports Windows, Linux, and macOS on x64 and arm64 and has these exact
requirements:

- Node.js 26 or newer on `PATH`; releases are built and tested with Node 26,
  and Node is not embedded in the package.
- npm, which is included with Node.js.
- A separately installed or built `srn-mcp` command for `doctor`, `ask`, and
  `chat`. The OpenClaw archive does not include the MCP bridge.

All production npm dependencies are bundled in the tarball. Installation is
therefore verified in CI with an empty npm cache and `--offline`; it does not
need registry access.

| Release artifact                                           | OS / architecture                 | Executable entrypoint                          |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| `srn-openclaw-<version>-node-any.tgz`                      | Windows, Linux, macOS; x64, arm64 | npm-generated `openclaw` / `openclaw.cmd`      |
| `srn-openclaw-<version>-node-any.manifest.json`            | All                               | Package, source, dependency, and test metadata |
| `srn-openclaw-<version>-node-any.provenance.sigstore.json` | All                               | Signed SLSA/Sigstore provenance bundle         |
| `SHA256SUMS.txt`                                           | All                               | SHA-256 checksums for the release assets       |

The same package is installed and smoke-tested on native Windows, Linux, and
macOS GitHub-hosted runners for both x64 and arm64. Each leg asserts the actual
Node platform and architecture, verifies the package contents, installs from an
empty cache, checks the dependency tree, and runs both `dist/index.js --help`
and the npm-generated command shim.

## Install a release

Download the `.tgz`, manifest, checksum file, and provenance bundle from the
matching GitHub release. Verify the files before installing them. On Linux:

```bash
sha256sum --check SHA256SUMS.txt
npm install --global --offline --ignore-scripts ./srn-openclaw-0.1.0-node-any.tgz
openclaw --help
```

On macOS, use `shasum -a 256 -c SHA256SUMS.txt` for the checksum step. On
Windows PowerShell, compare the tarball's result from
`Get-FileHash -Algorithm SHA256` with its line in `SHA256SUMS.txt`, then run:

```powershell
npm install --global --offline --ignore-scripts .\srn-openclaw-0.1.0-node-any.tgz
openclaw.cmd --help
```

GitHub also publishes a signed build-provenance attestation for the tarball and
manifest. With the GitHub CLI installed, verify the downloaded package against
the repository:

```bash
gh attestation verify srn-openclaw-0.1.0-node-any.tgz \
  --repo supermarsx/standard-red-notes
```

Replace `0.1.0` in the examples with the release version you downloaded.

## Configure OpenClaw

Create `~/.openclaw/config.toml`, or set `OPENCLAW_CONFIG` to another path.
Configure exactly one of `mcp.local` and `mcp.remote`.

```toml
[provider]
type = "ollama"
model = "llama3.1"
base_url = "http://127.0.0.1:11434"

[mcp.local]
command = "/absolute/path/to/srn-mcp"
args = []
scopes = ["read"]
env_from = ["STANDARD_RED_NOTES_MCP_TOKEN"]
timeout_ms = 60000
max_response_kb = 1024

[mcp.local.env]
MCP_TRANSPORT = "stdio"
STANDARD_RED_NOTES_ALLOW_WRITES = "0"
STANDARD_RED_NOTES_SERVER_URL = "http://127.0.0.1:3001"

[agent]
max_steps = 8
scratchpad_kb = 64
audit_file = "~/.openclaw/audit.log"

[security]
allow_filesystem_paths = []
```

Use an absolute MCP command path. A source build can instead use `command =
"node"` and an absolute path to `mcp/dist/index.cjs` in `args`. On POSIX, the
configuration file must not be group- or world-readable:

```bash
chmod 600 ~/.openclaw/config.toml
openclaw doctor
```

`env_from` names variables that OpenClaw copies from its own environment into
the local MCP child. Use it for `STANDARD_RED_NOTES_MCP_TOKEN` and other
credentials instead of writing their values in TOML. Missing named variables
fail closed. Literal, non-secret child settings belong under `[mcp.local.env]`.

For Streamable HTTP, replace the entire `mcp.local` section with:

```toml
[mcp.remote]
url = "https://mcp.example.test/mcp"
allow_remote = true
bearer_env = "MCP_HTTP_TOKEN"
scopes = ["read"]
timeout_ms = 60000
max_response_kb = 1024
```

`bearer_env` names an environment variable in the OpenClaw process; its value
is sent as the HTTP bearer credential but never stored in TOML. Non-loopback
URLs require HTTPS, `allow_remote = true`, and a bearer variable. The MCP bridge
serves plain HTTP, so expose it only through trusted TLS termination. A
loopback URL such as `http://127.0.0.1:3010/mcp` does not require the
`allow_remote` opt-in, but the bridge itself still requires `MCP_HTTP_TOKEN`.

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment when using the
corresponding hosted provider. Hosted providers receive the note and tool-result
content needed to answer a request; use a local Ollama/Hermes provider when that
content must remain on the machine.

## Security boundaries

- `read`, `write`, `files`, `export`, and `admin` are OpenClaw allow-list
  scopes. The MCP credential and server must independently grant the same or
  less authority.
- `files.attach` and `export.create` are local-only. They stay hidden unless
  their scope is granted and `security.allow_filesystem_paths` contains an
  existing directory. Paths are canonicalized and confined to those roots.
  Configure the matching `STANDARD_RED_NOTES_FILE_ROOTS` and
  `STANDARD_RED_NOTES_EXPORT_ROOTS` in the MCP child as a second boundary.
  Filesystem tools are always disabled over remote MCP.
- `scratchpad_kb` bounds retained model-visible conversation and tool-result
  history from 4 KiB to 1 MiB. `max_steps`, per-request timeouts, and MCP
  response limits bound the other agent loops and payloads.
- Audit records redact note bodies, credentials, token-shaped strings, and
  filesystem paths. On POSIX, OpenClaw creates a new audit directory with mode
  `0700`, forces the file to `0600`, and refuses symbolic links, hard links, or
  special files. It never changes an existing shared parent directory. On
  Windows, keep the audit file inside a private user-profile directory with an
  account-only NTFS ACL. Audit failures are logged but cannot change a tool
  result.
- Do not treat a timeout as proof that a write did not happen. Verify current
  note state before retrying an operation whose outcome is unknown.

## Commands

```text
openclaw doctor
openclaw ask "Which notes mention the budget?"
openclaw chat
```

## Build and test from source

From the repository root, with Node 26 and Yarn 4.17.1:

```bash
yarn install --immutable
yarn workspace @standard-red-notes/openclaw typecheck
yarn workspace @standard-red-notes/openclaw format:check
yarn workspace @standard-red-notes/openclaw test:unit
yarn workspace @standard-red-notes/openclaw test:e2e
```

The live E2E builds and starts the real local MCP bridge over stdio, exercises
the agent tool loop, and verifies that the child process is closed.
