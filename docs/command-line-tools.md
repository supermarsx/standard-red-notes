---
title: Command-Line Tools
description: Use srn-client, srn-server, and srn-admin safely and choose the correct command surface.
---

# Command-Line Tools

The repository contains three command-line surfaces with different trust and
deployment boundaries:

| Tool | Runs where | Primary role |
| --- | --- | --- |
| `srn-client` | User or automation host | Encrypted note CRUD, import, and export |
| `srn-server` | Operator workstation with repository/Compose access | Stack health, configuration, logs, and lifecycle |
| `srn-admin` | Inside the server container | Application administration and internal diagnostics |

Do not give a client automation job the Docker or in-container privileges needed
by the operator tools.

## `srn-client`

`srn-client` embeds the same headless `snjs` protocol path used by the MCP
bridge. It performs local key derivation and decryption; it is not a plaintext
REST wrapper.

Core commands:

```text
login | logout | whoami
notes list | notes get | notes create | notes update | notes delete
export --format json|md
import <file.json>
version | help
```

Example:

```bash
srn-client login --server https://notes.example.test --email me@example.test
srn-client notes list --limit 20
srn-client notes create --title "Incident note" --text "Started investigation"
srn-client export --out notes.json --format json
```

{% include safety-alert.html
  level="danger"
  title="Synchronized note deletion has no prompt"
  body="srn-client notes delete &lt;uuid&gt; tombstones and synchronizes the note without an interactive confirmation. Verify the UUID with notes get, create a current export or backup, and confirm the deletion on a second client before removing recovery copies."
%}

Prefer `SRN_PASSWORD` over `--password` so the password does not enter shell
history. On POSIX, profiles are stored under `~/.srn/data/<profile>/` with a
`0700` base directory and `0600` keychain/cookie/config files. `SRN_HOME`
overrides the base directory.

Exports are decrypted. Restrict the destination before running the command and
remove temporary copies when finished.

## `srn-server`

`srn-server` is a dependency-free Node tool around the public health endpoint
and Docker Compose:

```text
health | version
status | logs [service]
up [service] [--build]
down --yes [--volumes]
config [--env <path>] [--compose-config]
```

Examples:

```bash
srn-server health --url http://127.0.0.1:3001
srn-server config
srn-server status
srn-server logs server --tail 100
```

`config` without extra flags reports whether required secrets are present and
structurally valid without printing their values.

{% include safety-alert.html
  level="danger"
  title="Resolved Compose output can expose secrets"
  body="srn-server config --compose-config streams the fully resolved docker compose config output. That model can contain expanded environment values and secrets. Run it only in a private terminal, never paste the output into an issue or shared log, and delete any captured output securely."
%}

{% include safety-alert.html
  level="danger"
  title="Volume deletion is destructive"
  body="srn-server down --yes --volumes deletes persistent Compose volumes. Verify the resolved project, exact volumes, and restorable backups before adding --volumes."
  link_url="/backups-and-recovery.html#retention-and-deletion"
  link_text="Review backup retention and destructive cleanup"
%}

## `srn-admin`

The container image installs an `srn-admin` wrapper. Run it through Compose:

```bash
docker compose exec server srn-admin status
docker compose exec server srn-admin help
docker compose exec server srn-admin help users
```

Command groups include:

- **Users:** paginated listing, rich user lookup, bans, suspension, deletion,
  MFA reset, and quota repair.
- **Roles and groups:** role grant/revoke, group lifecycle, group roles, and
  membership.
- **Flags and storage:** per-user feature settings and storage limits.
- **Registration:** runtime gate, default role, domain policy, email
  confirmation, and signup policy.
- **Webhooks and integrations:** global/user webhooks, OCR, workflows, plugins,
  and effective operator configuration.
- **Anti-abuse:** IP allow/block lists and effective limits.
- **Diagnostics:** service readiness, bounded logs, and filtered audit events.

Use `--json` when consuming supported output programmatically. For interactive
changes, run the matching `help <command>` first.

## High-impact admin operations

| Operation | Safety control |
| --- | --- |
| `delete-user` | Requires `--confirm` equal to the account email; `--force` overrides the last-admin guard |
| `ban --type temporary` | Requires an end time or duration |
| `suspend` | Reversible hold that signs the user out and blocks sign-in |
| `reset-mfa` | Clears 2FA and recovery codes; does not recover encrypted data |
| role/group changes | Review effective permissions before and after |
| IP allow | Bypasses rate limits; use the smallest CIDR and record a reason |
| service lifecycle | Expect interruption and verify readiness afterward |

Administrative changes should be tied to a ticket or incident and followed by
an audit-log query.

## Shared server access key

`srn-client login` and `srn-server health` accept the optional shared server
access key through a flag or `SHARED_SERVER_ACCESS_KEY`. It is sent as
`X-Shared-Server-Key` only to the configured origin.

This key is a deployment gate/obfuscation layer, not end-to-end encryption and
not a substitute for TLS, account authentication, or network access control.

## Choosing the right tool

- For a note script, use `srn-client` or the [MCP Bridge](mcp-bridge.md).
- For “is the public service reachable?”, use `srn-server health`.
- For Compose status or logs, use `srn-server`.
- For users, roles, runtime settings, anti-abuse, internal readiness, or audit,
  use `srn-admin` or the [Administration](administration.md) console.
