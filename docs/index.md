---
title: Documentation
description: Guides, reference material, and operational runbooks for every Standard Red Notes surface.
---

<div class="docs-hero" markdown="1">

<p class="eyebrow">Private notes, fully documented</p>

# Understand, use, and operate Standard Red Notes

<p class="docs-hero__lede">
Follow a first-note walkthrough, compare every client, deploy your own server,
administer accounts, automate encrypted workflows, or trace the architecture
down to its verification gates.
</p>

<div class="docs-hero__actions">
  <a class="docs-button" href="onboarding.html">Start using the app</a>
  <a class="docs-button docs-button--secondary" href="self-hosting.html">Deploy a server</a>
</div>

</div>

Use the full-text search in the sidebar from any page. Press <kbd>Ctrl</kbd> +
<kbd>K</kbd> (or <kbd>⌘</kbd> + <kbd>K</kbd> on macOS), or press <kbd>/</kbd>
when you are not typing, to search page titles, headings, and body text.

{% include workspace-tour.html %}

## Choose a path

<div class="docs-card-grid">
  <section class="docs-card">
    <h3><a href="onboarding.html">Learn the product</a></h3>
    <p>Create a first note, choose an editor, organize a vault, use search, and understand what stays encrypted.</p>
    <p><a href="app-guide.html">Browse the complete in-app guide →</a></p>
  </section>
  <section class="docs-card">
    <h3><a href="client-platforms.html">Pick a client</a></h3>
    <p>Compare web, desktop, Android, iOS, and the browser clipper, including platform-only capabilities.</p>
    <p><a href="sync-and-data-lifecycle.html">Understand sync and offline data →</a></p>
  </section>
  <section class="docs-card">
    <h3><a href="self-hosting.html">Self-host and operate</a></h3>
    <p>Choose a deployment profile, configure a reverse proxy, protect data, monitor services, upgrade, and recover.</p>
    <p><a href="administration.html">Open the administration guide →</a></p>
  </section>
  <section class="docs-card">
    <h3><a href="command-line-tools.html">Automate and integrate</a></h3>
    <p>Use the encrypted client CLI, operator CLIs, MCP bridge, OpenClaw, HTTP API, webhooks, and integrations.</p>
    <p><a href="workflows.html">Connect n8n safely →</a></p>
  </section>
  <section class="docs-card">
    <h3><a href="security-and-account.html">Review security boundaries</a></h3>
    <p>Trace encryption, authentication, MFA, trusted devices, recovery, scoped credentials, sharing, and operator controls.</p>
    <p><a href="backups-and-recovery.html">Build a recovery plan →</a></p>
  </section>
  <section class="docs-card">
    <h3><a href="architecture.html">Build and verify</a></h3>
    <p>Map the monorepo, runtime services, request paths, CI gates, release contracts, and focused validation commands.</p>
    <p><a href="development-guide.html">Open the development guide →</a></p>
  </section>
</div>

## Feature atlas

The [Capability Map](capability-map.md) is the quickest way to see what ships
across the app, server, desktop and mobile packages, CLIs, MCP bridge, OpenClaw,
administration surfaces, backups, and integrations. It labels each capability
as one of:

- **Shipped** — executable implementation and supporting evidence are present.
- **Operator-gated** — the implementation must be enabled or configured.
- **Planned** — the repository contains a design, not a runtime promise.

That distinction is especially important for the separate
[MCP](MCP_SUPPORT_PLAN.md) and [OpenClaw](OPENCLAW_PLAN.md) design documents.
The current n8n runtime and security boundary is documented in
[Workflows with n8n](workflows.md).

## Documentation principles

- Encryption boundaries and any intentional plaintext path are named directly.
- Runtime guides and future plans are separated in navigation.
- Copy-ready commands include the directory and assumptions that make them safe.
- Destructive recovery and administration steps put backups and verification first.
- Capability claims point back to implementation, tests, configuration, or release contracts.
