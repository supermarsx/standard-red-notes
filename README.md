# Standard Red Notes

[![GitHub stars](https://img.shields.io/github/stars/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/network/members)
[![GitHub issues](https://img.shields.io/github/issues/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/issues)
[![Last commit](https://img.shields.io/github/last-commit/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/commits)
[![Top language](https://img.shields.io/github/languages/top/supermarsx/standard-red-notes?style=flat)](https://github.com/supermarsx/standard-red-notes)
[![CI](https://img.shields.io/badge/CI-see%20Actions-lightgrey?style=flat&logo=githubactions)](https://github.com/supermarsx/standard-red-notes/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat)](LICENSE)

> A friendly, private, **end-to-end encrypted** notes app you run yourself — with
> every feature included, no paid tier, and nothing gatekept.

Standard Red Notes is an open, AGPL-3.0 licensed, **self-hosted fork of
[Standard Notes](https://standardnotes.com)**. It keeps the things that make
Standard Notes great — strong end-to-end encryption, a clean cross-platform
client, and a sync server you can host yourself — and removes the part that
gets in the way: the subscription. Where the upstream project puts a number of
features behind a paid plan, this fork ships **the full feature set on by
default**. The server runs with `STANDARD_RED_FEATURES_MODE=included`, so
feature and subscription checks return full access without any subscription
provisioning. You host it, you own the data, and nothing is held back.

This is an independent project and is **not affiliated with, sponsored by, or
endorsed by Standard Notes**. Upstream copyright and attribution are preserved.

> New here and want to *use* the app? Read the
> [onboarding guide](docs/onboarding.md) — accounts, editors, organizing notes,
> the AI assistant, and what stays private. Want to *run a server*? Jump to the
> [Docker quickstart](#docker-quickstart) or the full
> [self-hosting guide](docs/self-hosting.md).

## Table of contents

- [Why this fork](#why-this-fork)
- [What's different / improved](#whats-different--improved)
- [Repository layout](#repository-layout)
- [Docker quickstart](#docker-quickstart)
- [Building from source](#building-from-source)
- [Command-line tools](#command-line-tools)
- [Product direction](#product-direction)
- [License](#license)

## Why this fork

Standard Notes is excellent software with a sustainable hosted business — and
that business gates some of the nicer features behind a subscription. If you are
happy to run your own server, you do not need that gate. Standard Red Notes
takes the AGPL-3.0 source and makes the self-hosted product the first-class
target:

- **No paid tier, nothing gatekept.** Every included feature is on for every
  account on your instance. There is no "upgrade to unlock" and no subscription
  to provision — full access is the baseline product mode, not a perk.
- **Self-hosted first.** The defaults target your own server, not a hosted
  service. One setup script generates a complete `.env` with secure secrets and
  brings the Docker Compose stack up.
- **You own your data.** Notes are end-to-end encrypted on your device before
  they sync; the server only ever stores ciphertext it cannot read.
- **Genuinely open.** AGPL-3.0 means you can inspect, modify, and run it
  yourself — and anyone you offer it to over a network is entitled to the
  source.

## What's different / improved

On top of the upstream client and server, this fork adds and unlocks a broad set
of features. The highlights below are all present in this repository:

| Area | What you get |
| --- | --- |
| **All features included** | The server runs in `included` features mode, so no feature or note type is gated behind a subscription. |
| **AI assistant** | An optional assistant (Preferences → Assistant) you point at any OpenAI-compatible endpoint — local (LM Studio, Ollama) or hosted. You pick the **context scope** (current note, whole notebook, a tag/folder/selection) so it only sees what you choose. |
| **Assistant actions** | **Suggest tags**, **auto-organize** notes, **conflict merge** assistance, and note **narration / text-to-speech** (model voices or your device's built-in browser voices). |
| **Many note types** | Plain text, **Super** rich blocks, **Canvas** (freeform drawing), **Bases**, **Calendar**, **Kanban**, **Timeline**, and code **sandboxes** — a JS Sandbox (jsfiddle-style) and a Web App Sandbox (codepen-style live preview). |
| **Super editor blocks** | Checklists, tables, code, **math** (inline and block), **footnotes**, **web embeds**, **kanban**, and **timeline** blocks — inserted from the `/` block picker. |
| **Super editing power** | Collapsible / **foldable** sections and **multi-cursor** editing. |
| **PDF viewer** | A built-in **PDF.js** preview with **deep links** to a specific page/position. |
| **Search** | Full-text search across titles and content, plus an optional local **search index** and **relevance ranking** that run entirely in your browser. |
| **Linking & navigation** | **Bidirectional links** (notes and their backlinks), the **constellation** graph (an interactive "star map" of how notes connect), and a keyboard-driven **command palette**. |
| **Collaboration** | Vaults, contacts, and invites for sharing notes with others. |
| **Privacy controls** | **Protected notes**, **selective sync** (local-only notes that never upload), and **trusted devices**. |
| **Appearance** | Auto **light/dark** theme that follows your system, plus additional themes. |
| **Spellcheck** | Multi-language spellcheck configuration. |
| **CLI tools** | `srn-client` (real end-to-end-encrypted note CRUD from the terminal) and `srn-server` (operator helpers: health, status, logs, config validation). |
| **MCP bridge** | An MCP stdio bridge (`mcp/`) so MCP-capable clients can talk to your server. |
| **Self-hosting** | One-command setup scripts (`scripts/setup.sh` / `scripts/setup.ps1`) and a documented Docker Compose stack. |

> A note on accuracy: features like the AI assistant and narration decrypt notes
> locally but send the content you point them at to the AI provider you
> configure. See the [onboarding guide](docs/onboarding.md#security-what-leaves-your-device)
> for an honest breakdown of what crosses the end-to-end boundary.

## Repository layout

This repository preserves the upstream package boundaries:

- `app/` — web, desktop, mobile, and shared client packages.
- `server/` — auth, sync, files, revisions, websockets, home server, and
  supporting packages.
- `mcp/` — Standard Red Notes MCP bridge bootstrap.
- `cli/` — standalone command-line tools (`srn-client`, `srn-server`).
- `scripts/` — self-hosting setup scripts.
- `docs/` — onboarding, self-hosting, and project planning docs.

The app and server still use their upstream Yarn projects internally. The root
package is a coordinator for monorepo scripts and new packages while the larger
workspace migration is phased in.

## Docker quickstart

The fastest way to run your own instance. This gets you a local server with the
web app open in your browser; for production (custom domain, TLS, reverse proxy)
follow the [full self-hosting guide](docs/self-hosting.md).

### Prerequisites

- **Docker** and the **Docker Compose** plugin installed and running.
- A copy of this repository.

### 1. Get the code

```bash
git clone https://github.com/supermarsx/standard-red-notes.git
cd standard-red-notes
```

### 2. Run the setup script

The setup script checks that Docker is present, asks a few questions (press
Enter through them for a localhost install), generates all secrets, and writes a
complete `.env` file.

```bash
# macOS / Linux
./scripts/setup.sh

# Windows (PowerShell)
./scripts/setup.ps1
```

Helpful flags:

- `--up` (bash) / `-Up` (PowerShell) — also run `docker compose up -d` once the
  `.env` is written.
- `--yes` (bash) / `-Yes` (PowerShell) — non-interactive; accept all defaults.

### 3. Start the stack

If you did not pass the "up" flag:

```bash
docker compose up -d
```

This builds and starts the web app, the all-in-one self-hosted server, MySQL,
Redis, and a LocalStack SNS/SQS for messaging.

### 4. Open it

- Web app: <http://localhost:3001>
- API gateway: <http://localhost:3000>
- Files service: <http://localhost:3125>

Choose **Register** in the web app to create your account. There is nothing to
purchase — self-hosted instances ship with all features included.

### Everyday operations

```bash
docker compose ps              # see what's running
docker compose logs -f         # follow logs (add a service name to narrow)
docker compose down            # stop the stack
docker compose pull && docker compose up -d   # update and restart
```

The optional MCP stdio bridge is only started when a client needs it:

```bash
docker compose --profile mcp run --rm mcp
```

### Full guide and reverse proxy

For the complete walkthrough — every environment variable explained, choosing a
domain and ports, **running behind a reverse proxy (nginx / Traefik)**, where
your data lives, upgrades, and backup/restore — see
**[docs/self-hosting.md](docs/self-hosting.md)**. `.env.example` documents every
configuration key.

## Building from source

Root-level coordinator scripts:

```powershell
yarn install
yarn build:mcp
yarn start:mcp
yarn deps:audit
```

The full app and server builds still run through their existing project-level
scripts:

```powershell
yarn --cwd app build:all
yarn --cwd server build
```

You can also drive the Docker stack via the coordinator scripts:

```powershell
yarn docker:config
yarn docker:up
```

## Command-line tools

Two standalone CLI tools live in `cli/` (each is independent and does not touch
the app/server lockfiles):

- **`srn-client`** — manage a Standard Red Notes account from the terminal with
  **real, end-to-end-encrypted note CRUD**. It runs the actual protocol
  (SRP sign-in, argon2 root-key derivation, items-key decryption) via an
  embedded headless `@standardnotes/snjs` client, so changes sync back encrypted
  exactly like the web/desktop app. See
  [`cli/srn-client/README.md`](cli/srn-client/README.md).
- **`srn-server`** — operator helpers for the Docker stack: health checks, stack
  status, logs, config validation, and thin `docker compose` wrappers. Zero
  runtime dependencies. See [`cli/srn-server/README.md`](cli/srn-server/README.md).

## Product direction

The fork defaults target a self-hosted Standard Red Notes server, not the hosted
Standard Notes service. Full-feature access is the baseline product mode, not a
subscription or entitlement. The project does not implement client-side bypasses
for third-party hosted services.

See:

- [Roadmap](docs/ROADMAP.md)
- [MCP Support Plan](docs/MCP_SUPPORT_PLAN.md)
- [No-Entitlement Plan](docs/NO_ENTITLEMENT_PLAN.md)
- [Dependency Upgrade Audit](docs/DEPENDENCY_UPGRADE_AUDIT.md)
- [Fork Compliance Notes](docs/FORK_COMPLIANCE.md)

## License

Standard Red Notes is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0). See the [LICENSE](LICENSE) file for the full text. Because the AGPL
covers network use, anyone you offer this software to over a network is entitled
to its corresponding source.

This project is a self-hosted fork of [Standard Notes](https://standardnotes.com),
which is also distributed under the AGPL-3.0. Upstream copyright and attribution
notices are preserved. Standard Red Notes is an independent project and is not
affiliated with, sponsored by, or endorsed by Standard Notes.
