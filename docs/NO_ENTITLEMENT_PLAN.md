# No-Entitlement Plan

## Goal

Standard Red Notes should treat every self-hosted user as fully featured by default. There should be no paid tiers, subscription locks, entitlement prompts, feature paywalls, offline subscription codes, or "upgrade to use this" flows in the fork's normal product mode.

The implementation should remove entitlement as a product concept, not fake entitlement state in the client. The long-term model is:

- All local users can use all Standard Red Notes features.
- Roles and permissions remain only as security/admin primitives where they protect data or server operations.
- Legacy subscription tables and endpoints remain temporarily as compatibility shims until app/server code no longer depends on them.
- Hosted Standard Notes billing and purchase systems are not used by fork defaults.

## Product Principles

- Full-feature access is the baseline, not a grant.
- The client should ask "can this server do this?" rather than "has this user paid for this?"
- Security checks stay intact: auth, MFA, vault unlock, note locks, session validation, sync ownership, file ownership, admin authorization, and MCP permissions.
- Storage, file size, invite count, and abuse limits are operational quotas, not subscription limits.
- Legacy compatibility is allowed only when it reduces migration risk and is clearly named as legacy.

## Current Locks To Remove

Server-side:

- `FeatureService.userIsEntitledToFeature` and `GetUserFeatures` derive availability from roles, subscriptions, and offline subscription records.
- `ActivatePremiumFeatures` creates subscription records and applies subscription settings.
- `RoleToSubscriptionMap` maps plans to roles.
- Subscription settings hold file upload limits and related values.
- Subscription invite/token/offline subscription endpoints expose billing-shaped workflows.
- Some feature checks protect product features such as U2F, files, note history, editors, themes, vaults, and sharing.

Client-side:

- `FeaturesController` stores `entitledToFiles` and opens premium modals.
- Premium modal and purchase flow components show upgrade prompts.
- Editor/theme/file/tag/vault/note-history surfaces branch on `FeatureStatus.Entitled` or subscription state.
- Account preferences show subscription and subscription sharing pages.
- Offline subscription UI accepts subscription activation codes.
- Desktop home server still exposes `activatePremiumFeatures`.

## Target Architecture

### Capability Policy

Add a server capability policy that answers whether the deployment includes each feature. For Standard Red Notes self-hosted mode, all product features return included.

Proposed names:

- `STANDARD_RED_FEATURES_MODE=included|legacy`
- `STANDARD_RED_STORAGE_QUOTA_BYTES=-1`
- `STANDARD_RED_FILE_UPLOAD_BYTES_LIMIT=-1`
- `STANDARD_RED_MAX_SHARED_VAULTS=-1`
- `STANDARD_RED_MAX_SUBSCRIPTION_INVITES=0`

`included` is the default. `legacy` exists only for upstream compatibility or future hosted experiments.

### Compatibility Bridge

Use `STANDARD_RED_FEATURES_MODE=included` as the default path. Feature queries return all known features as included and non-expiring, and subscription queries return a virtual Pro-shaped response without requiring a stored subscription row.

Keep `STANDARD_RED_ENTITLEMENT_MODE=provisioned-full` only as a deprecated compatibility bridge for deployments that intentionally need old subscription-row provisioning.

Bridge behavior:

- Return subscription-shaped full access for old clients without billing or purchase state.
- Create a long-lived local Pro-shaped record only when the deprecated provisioning bridge is explicitly enabled.
- Do not show this as a subscription to users.
- Do not expose purchase, billing, cancellation, renewal, or hosted dashboard links.
- Add migration tests so removing the bridge later is deliberate.

### Feature API

Add a deployment capability endpoint, for example:

- `GET /v1/capabilities`
- `GET /v1/users/:uuid/capabilities`

Response shape:

```json
{
  "product": "standard-red-notes",
  "featuresMode": "included",
  "includedFeatures": ["files", "editors", "themes", "vaults", "revisions", "mfa", "sharing"],
  "quotas": {
    "fileUploadBytesLimit": -1,
    "storageQuotaBytes": -1,
    "sharedVaultLimit": -1
  },
  "legacySubscriptionCompatibility": true
}
```

The client uses this endpoint before rendering purchase or feature-lock UI.

## Implementation Phases

### Phase 1 - Rename The Concept

- Add `docs/NO_ENTITLEMENT_PLAN.md` as the source of truth.
- Rename user-facing docs from "entitlements" to "included features."
- Keep code names untouched in this phase unless the rename is mechanical and low risk.
- Add deprecation comments around `STANDARD_RED_ENTITLEMENT_MODE` explaining it is a bridge, not the target design.
- Configure Docker and server defaults for `STANDARD_RED_FEATURES_MODE=included`.

Acceptance:

- No roadmap/readme copy describes full features as an entitlement.
- The documented target mode is "included features."

### Phase 2 - Server Capability Layer

- Add a `CapabilityPolicy` service in auth or a shared server package.
- Bind it from environment with default mode `included`.
- Add use cases/controllers for deployment and per-user capabilities.
- Make product feature availability resolve from `CapabilityPolicy` first.
- Keep role checks for admin-only, owner-only, and data-security operations.

Acceptance:

- New and existing users get the same included feature set without requiring a subscription record in new code paths.
- U2F, files, revisions, editors, themes, vaults, and sharing all report included under self-hosted mode.
- Legacy clients still work through the bridge.

### Phase 3 - Server Subscription Decoupling

- Split subscription-shaped settings into neutral operational settings:
  - file upload limit;
  - file bytes used;
  - sign-in email notification preference;
  - sharing/invite quota;
  - revision retention.
- Add repositories/use cases that read neutral settings first and fall back to subscription settings.
- Stop using `ActivatePremiumFeatures` during registration once neutral capability responses are consumed by the client.
- Keep migration commands for existing rows.
- Remove or hide subscription invite/token/offline subscription routes from self-hosted public API documentation.

Acceptance:

- Registration no longer needs to create a subscription row in included mode.
- Existing data with subscription rows still works.
- File quotas and settings work from neutral settings.

### Phase 4 - Client Unlock Pass

- Add a client `CapabilitiesController` or SNJS service backed by the new endpoint.
- Replace `entitledToFiles` and similar flags with `features.files.included`, `features.vaults.included`, etc.
- Remove premium modal activation calls from:
  - file drag/drop and file attachment;
  - editor/theme selection;
  - folders/smart views;
  - vault limits;
  - revision history;
  - moments and backups.
- Hide purchase flow, plans links, subscription dashboard links, account subscription panes, subscription sharing upsells, and offline subscription-code UI in included mode.
- Replace user-facing text with included-feature language only where some status still needs to be shown.

Acceptance:

- No normal user action opens an upgrade or purchase UI.
- Features are usable immediately after account creation.
- Client still honors security locks such as note locks, vault locks, and auth state.

### Phase 5 - Data Migration

- Add an idempotent migration command:
  - reads existing subscription settings;
  - writes neutral operational settings;
  - records migration completion;
  - leaves old rows untouched until a later cleanup.
- Add an audit command to report users still depending on legacy subscription compatibility.
- Add seed data for included-mode local development.

Acceptance:

- A deployment can migrate without deleting subscription rows.
- Running the migration twice is safe.
- Rollback means switching capability reads back to legacy fallback.

### Phase 6 - Remove Legacy Surfaces

- Remove hosted purchase URLs from defaults permanently.
- Remove or archive purchase flow components from the fork build.
- Remove offline subscription activation UI.
- Remove subscription-sharing upsell flows; if sharing remains useful, reframe it as "sharing seats" or "collaborators" with operational quotas.
- Remove desktop `activatePremiumFeatures` once home server no longer needs it.
- Rename internal APIs only after all call sites have moved.

Acceptance:

- Searching the fork UI for `upgrade`, `premium`, `purchase`, `plans`, and `subscription code` finds no active self-hosted flows.
- Remaining `subscription` code is either migration/legacy compatibility or explicitly disabled in included mode.

### Phase 7 - Cleanup And Hardening

- Delete dead compatibility code after one stable release cycle.
- Add regression tests that prove new users have all features without subscription rows.
- Add e2e tests for files, editors, themes, vaults, revisions, MFA, and sharing on a fresh account.
- Add API tests proving paid/billing endpoints are not reachable in included mode unless explicitly enabled for legacy.
- Update MCP server tools from `entitlements.status` to `capabilities.status`.

Acceptance:

- A fresh database with one new user has no paid-tier dependency.
- All feature access tests pass with no seeded subscription.
- Documentation no longer teaches operators to create subscriptions for feature access.

## Test Matrix

Server:

- Register user in `included` mode without subscription creation.
- Fetch deployment/user capabilities.
- Fetch features for a user with no subscription rows.
- Use files with unlimited and finite quota settings.
- Use U2F/MFA without paid roles.
- Use revisions and vaults without paid roles.
- Verify admin-only operations still require admin authorization.

Client:

- New account can attach files.
- New account can switch to every bundled editor.
- New account can apply every bundled theme.
- New account can create folders, smart views, vaults, and shared vault flows.
- Revision history is available according to operational retention settings.
- No upgrade modal appears during normal use.
- Subscription preferences are hidden or replaced by included-feature status.

Migration:

- Existing users with Pro/Plus/Core data migrate to neutral settings.
- Existing users with expired/canceled subscriptions still receive included features after migration.
- Legacy compatibility bridge can be disabled only after clients use capability endpoint.

## Risks

- Some packages use `FeatureStatus.Entitled` deeply; changing names too early will create broad churn.
- Subscription settings currently hold useful operational settings, so data decoupling must come before deletion.
- Mobile and desktop may cache feature status differently than web.
- Offline mode may still depend on offline subscription-shaped records.
- Removing too much at once can break self-hosted compatibility with existing accounts.

## Immediate Next Slice

1. Add `CapabilityPolicy` and a read-only capabilities endpoint.
2. Update web startup to fetch capabilities and suppress purchase UI when mode is `included`.
3. Add broader tests for new-user full-feature flows with no subscription rows.
4. Move file quota from subscription setting fallback to neutral setting.
5. Remove or hide remaining subscription-sharing and offline-code routes from included-mode UI.
