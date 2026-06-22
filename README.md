# Standard Red Notes

[![GitHub stars](https://img.shields.io/github/stars/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/network/members)
[![GitHub issues](https://img.shields.io/github/issues/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/issues)
[![Last commit](https://img.shields.io/github/last-commit/supermarsx/standard-red-notes?style=flat&logo=github)](https://github.com/supermarsx/standard-red-notes/commits)
[![Top language](https://img.shields.io/github/languages/top/supermarsx/standard-red-notes?style=flat)](https://github.com/supermarsx/standard-red-notes)
[![CI](https://img.shields.io/badge/CI-see%20Actions-lightgrey?style=flat&logo=githubactions)](https://github.com/supermarsx/standard-red-notes/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat)](LICENSE.md)

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
- [Feature comparison](#feature-comparison)
- [Repository layout](#repository-layout)
- [Docker quickstart](#docker-quickstart)
- [Building from source](#building-from-source)
- [Command-line tools](#command-line-tools)
- [API](#api)
- [License](#license)

## Why this fork

Standard Notes is genuinely great software — strong end-to-end encryption, a
clean cross-platform client, and a self-hostable sync server. But upstream
development has largely stalled, and a project this good shouldn't be allowed to
quietly slide into abandonware. **This fork is, first and foremost, about
modernization: keeping great software alive, current, and moving forward instead
of letting a vacuum form around it.** Concretely, that means an updated
dependency stack and toolchain, refreshed builds and Docker/reverse-proxy setup,
ongoing bug fixes, and a steady stream of new capabilities — so you're running a
living, maintained codebase rather than a frozen snapshot of an app that
deserves to keep going.

The second thing it changes is the business model. Standard Notes gates some of
the nicer features behind a subscription; if you are happy to run your own
server, you do not need that gate. Standard Red Notes takes the AGPL-3.0 source
and makes the self-hosted product the first-class target:

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
of features — and brings the whole project up to date: the **frontend and backend
dependencies and toolchain have been modernized** (libraries updated, builds and
Docker/reverse-proxy setup refreshed) so you're running a current, maintained stack
rather than a frozen snapshot. The highlights below are all present in this repository:

| Area | What you get |
| --- | --- |
| **All features included** | The server runs in `included` features mode, so no feature or note type is gated behind a subscription. |
| **Modernized stack** | Frontend and backend **dependencies and build toolchain updated**, **reverse-proxy-friendly Docker** setup, a top-level `Makefile`, and documented [HTTP API](docs/API.md). |
| **AI assistant** | An optional assistant (Preferences → Assistant) you point at any OpenAI-compatible endpoint — local (LM Studio, Ollama) or hosted. You pick the **context scope** (current note, whole notebook, a tag/folder/selection) so it only sees what you choose. AI features are **opt-in and off by default**. |
| **Assistant actions** | **Suggest tags**, **auto-organize** notes, **conflict-merge** assistance, **AI auto-resolve conflicts**, note **narration / text-to-speech**, **speech-to-text / dictation**, **contextual AI search** (re-rank results), and a bounded **deep-research** mode over your own notes. |
| **Many note types** | Plain text, **Super** rich blocks, **Canvas** (freeform drawing), **Bases**, **Calendar**, **Kanban**, **Timeline**, **Flashcards** (with study mode), a **Map** type (mind maps / family trees), and code **sandboxes** — a JS Sandbox (jsfiddle-style) and a Web App Sandbox (codepen-style live preview). |
| **Super editor blocks** | Checklists, tables, code, **math**, **footnotes**, **web embeds**, **kanban**, **timeline**, **QR codes**, **TradingView** & **stock charts**, an in-browser **SQL** block, **gantt / timing / music-staff** charts, and a live **clock / world-clock** — from the `/` block picker. |
| **Super editing power** | Collapsible / **foldable** sections, **multi-cursor** editing, a **customizable** Word-style toolbar with **contextual widget groups**, and **block zoom**. |
| **Reminders & journaling** | Per-note **reminders** (one-off and **recurring**), browser **notifications**, optional server-sent **email reminders**, and a **diary mode** that prompts a daily entry. |
| **Dashboards & views** | A **Dashboard** with account stats, **Achievements**, and aggregate views for **Reminders**, **Calendar**, **Todos**, and a Zotero-like **Research** library — plus a fully **customizable Home** page. |
| **Sync & real-time** | **Websocket-first** delta sync (HTTP fallback), an optional **manual-sync** mode, live **co-editing + presence** in shared vaults, and a **Sync control** pane showing what's local-only. |
| **Search** | Full-text search with a local **index** and **relevance ranking**, **advanced operators** (`tag:`, `type:`, `is:`, dates…), **find-in-PDF**, and optional **AI re-ranking** — all in your browser. |
| **Files** | **Bulk file & folder uploads**, **large local-only files**, automatic **EXIF/metadata stripping** on image upload, in-app **audio playback**, and download-all-images-as-zip. |
| **Account & security** | **Passkey** sign-in and **passkey app-lock**, **multiple workspaces per email** (server-configurable), **trusted devices**, **burn-note** one-view shares, **bannable users**, **app passwords / MCP tokens**, and scheduled **encrypted email backups**. |
| **Import / export** | Import from **Evernote, Google Keep, OneNote, Zoho Notebook, CSV**; export to **`.ics`**, **Excel/Word** (spreadsheets), **print/PDF**, and encrypted backups. |
| **Linking & navigation** | **Bidirectional links** and backlinks, the **constellation** graph, and an extended keyboard-driven **command palette**. |
| **Collaboration** | Vaults, contacts, and invites, surfaced in a **Sharing** settings pane. |
| **Privacy controls** | **Protected notes**, **selective sync**, **trusted devices**, and configurable **trash auto-cleanup**. |
| **Appearance & personalization** | Auto **light/dark** theme, **custom themes with custom accent colors**, **font ligatures**, per-note colors, a per-note **hero cover image**, and a **profile picture**. |
| **Localization** | An i18n framework with **16 locales**, switchable in settings. |
| **Spellcheck** | Multi-language spellcheck configuration. |
| **CLI tools** | `srn-client` (real end-to-end-encrypted note CRUD from the terminal) and `srn-server` (operator helpers: health, status, logs, config validation). |
| **MCP bridge** | An MCP stdio bridge (`mcp/`) so MCP-capable clients can talk to your server. |
| **Self-hosting** | One-command setup scripts (`scripts/setup.sh` / `scripts/setup.ps1`) and a documented, reverse-proxy-ready Docker Compose stack. |

> A note on accuracy: features like the AI assistant and narration decrypt notes
> locally but send the content you point them at to the AI provider you
> configure. See the [onboarding guide](docs/onboarding.md#security-what-leaves-your-device)
> for an honest breakdown of what crosses the end-to-end boundary.

## Feature comparison

How the upstream hosted **Standard Notes** offering compares with **Standard Red
Notes** (this fork). Standard Notes is excellent software with a sustainable
business; it offers a capable free tier and reserves a number of "Productivity"
features for its paid subscription. Standard Red Notes targets self-hosting
instead: every included feature is on for every account, with no paid tier — the
trade-off is that **you run and maintain the server yourself**. This table is
cross-checked against the "What's different / improved" features this repository
actually ships.

| Capability | Standard Notes (free) | Standard Notes (paid / Productivity) | Standard Red Notes (this fork) |
| --- | --- | --- | --- |
| End-to-end encryption | Yes | Yes | Yes |
| Unlimited notes, tags, nested folders | Yes | Yes | Yes |
| Multi-device sync | Yes | Yes | Yes |
| Plain text / basic editing | Yes | Yes | Yes |
| Rich / Super block editor, Markdown, code, advanced note types | Limited | Subscription-gated | Included (Super blocks, Canvas, Bases, Calendar, Kanban, Timeline, code sandboxes) |
| Themes / appearance | Default theme | Extra themes via subscription | Included (auto light/dark + extra themes) |
| Encrypted file attachments / storage | Not on free tier | Subscription-gated (storage quota) | Included (limits are your server's storage) |
| Note history / revisions | Short retention | Extended retention via subscription | Included (retention is your server's config) |
| Two-factor authentication | Yes | Yes | Yes (TOTP, magic link, WebAuthn) |
| Encrypted backups & email backups | Local export | Email/cloud backups via subscription | Included (export, and email/automatic where configured) |
| Collaboration / shared vaults | No | Yes (on supported plans) | Included (vaults, contacts, invites, realtime relay) |
| AI assistant / actions | Not offered | Not offered | Included (bring-your-own OpenAI-compatible endpoint or server proxy) |
| Public share links, dead-man's switch, email reminders | No | No | Included (fork-specific) |
| App passwords / scoped MCP tokens / MCP bridge | No | No | Included (fork-specific) |
| Hosting | Managed by Standard Notes | Managed by Standard Notes | Self-hosted by you |
| Cost | Free | Paid subscription | Free (you provide the server) |

> "Subscription-gated" reflects upstream's hosted product at a high level and may
> shift over time; check [standardnotes.com](https://standardnotes.com) for their
> current plans. The right-most column reflects what this repository ships today.
> Self-hosting means you are responsible for running, securing, and backing up
> the server.

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

Run your own instance in three commands. **Prerequisite:** Docker with the
Compose plugin, installed and running.

```bash
git clone https://github.com/supermarsx/standard-red-notes.git
cd standard-red-notes
./scripts/setup.sh --up        # Windows (PowerShell): ./scripts/setup.ps1 -Up
```

`setup` generates a complete `.env` with secure secrets; `--up` then brings the
stack up (web app, server, MySQL, Redis, LocalStack). When it finishes, open
**<http://localhost:3001>** and choose **Register** — every feature is included,
nothing to purchase.

<details>
<summary>Manual setup &amp; everyday commands</summary>

```bash
./scripts/setup.sh             # write .env only (add --yes to accept all defaults)
docker compose up -d           # start the stack
docker compose ps              # what's running
docker compose logs -f         # follow logs (append a service name to narrow)
docker compose down            # stop
docker compose pull && docker compose up -d    # update and restart
docker compose --profile mcp run --rm mcp      # optional MCP stdio bridge
```

Other endpoints: API gateway <http://localhost:3000>, files
<http://localhost:3125>.
</details>

For production — every environment variable, **reverse proxy (nginx / Traefik)**,
data locations, upgrades, and backup/restore — see the
**[self-hosting guide](docs/self-hosting.md)**.

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

### Prebuilt binaries and releases

Each CLI tool is released independently as native, single-file executables via
GitHub Actions — **no manual tagging required**. Releases roll automatically:

- **Triggers.** Pushing to `main` runs the per-tool workflow when that tool's
  directory changes — [`release-srn-client.yml`](.github/workflows/release-srn-client.yml)
  on `cli/srn-client/**`, [`release-srn-server.yml`](.github/workflows/release-srn-server.yml)
  on `cli/srn-server/**`. Both can also be run on demand from the Actions tab
  (`workflow_dispatch`).
- **Pipeline.** Each workflow is gated: **check → build → package → release**
  (a stage only runs if the previous one passed). Packaging cross-compiles with
  [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) on a single Linux runner.
- **Versioning.** Rolling, per tool, `YY.N` resetting each year (e.g. the first
  2025 client release is `25.1`, the next `25.2`, …). The server tool counts
  independently. The workflow computes `N` at release time from existing
  releases and creates a namespaced tag (`srn-client-v25.1`, `srn-server-v25.1`).
- **Artifacts.** Every release attaches **6 executables** — Windows, macOS, and
  Linux, each in `x64` and `arm64` (Windows ones end in `.exe`) — plus a
  `SHA256SUMS.txt`. Download the one matching your platform, verify the checksum,
  and run it directly. The two tools release as separate GitHub Releases.

`ci.yml` additionally runs the full monorepo check + build (root, `app/`, and
`server/` Yarn PnP installs) plus both CLIs on every pull request.

## API

Your self-hosted server exposes the full Standard Notes HTTP API through the API
gateway — sign-in (PKCE), sync (`POST /v1/items`), items/files, settings,
sessions, two-factor, collaboration, plus this fork's additions (app passwords,
MCP tokens, public share links, the AI assistant proxy, and more).

See **[docs/API.md](docs/API.md)** for the full reference: base URL and
versioning, the authentication model (PKCE + bcrypt-derived server password,
`Authorization: Bearer` access tokens, refresh), a curl walkthrough, and every
endpoint grouped by area. Because notes are end-to-end encrypted, item payloads
are ciphertext — the easiest faithful client is the bundled
[`srn-client`](cli/srn-client/README.md), which runs the real protocol. The API
docs are also linked in-app under **Preferences → Documentation → Automation
(MCP) → The HTTP API**.

## License

Standard Red Notes is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0). See the [LICENSE.md](LICENSE.md) file for the full text. Because the AGPL
covers network use, anyone you offer this software to over a network is entitled
to its corresponding source.

This project is a self-hosted fork of [Standard Notes](https://standardnotes.com),
which is also distributed under the AGPL-3.0. Upstream copyright and attribution
notices are preserved. Standard Red Notes is an independent project and is not
affiliated with, sponsored by, or endorsed by Standard Notes.
