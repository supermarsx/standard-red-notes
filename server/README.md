# Standard Red Notes Server

Server applications monorepo for Standard Red Notes. This fork keeps the upstream service boundaries while the root repository coordinates app, server, and MCP work.

## Included Features

New registrations default to full-feature self-hosted mode without needing subscription rows. Feature and subscription queries synthesize included Pro-level access in the normal Standard Red Notes runtime.

Environment controls:

- `STANDARD_RED_FEATURES_MODE=included|legacy`
- `STANDARD_RED_ENTITLEMENT_MODE=included|provisioned-full|subscription` (deprecated compatibility bridge)
- `STANDARD_RED_FULL_FEATURE_DURATION_DAYS=36500`
- `STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES=-1`

Use included-feature mode for Standard Red Notes deployments. Use legacy/subscription mode only for compatibility testing, and avoid `provisioned-full` unless you intentionally need old subscription-shaped provisioning.

## Dependency Compatibility

- TypeScript is pinned to `6.0.3`, the newest stable release accepted by
  `typescript-eslint 8.64.0` (`>=4.8.4 <6.1.0`). TypeScript 7 must wait for a
  supported typescript-eslint release.
- `better-sqlite3 12.11.1` is the current release and supports Node 26, but it
  still depends on the deprecated `prebuild-install 7.1.3`. The high-severity
  security audit is clean; this transitive deprecation remains until upstream
  replaces its native-binary installer.
- `.yarnrc.yml` contains strict-PnP dependency bridges for upstream Commitlint
  and Inversify meta-packages that do not forward required child peers. These
  bridges provide the dependencies; they do not suppress or mark peers optional.

### Account activity and complete storage measurements

`POST /v1/sessions/activity` records a server-timed observation for the authenticated session and an opaque browser-profile device ID. The client sends observations every 30 seconds; “active recently” means observed within the last 120 seconds. An open session is an unexpired sign-in and does not imply a browser is online. Session responses preserve their array format and add `last_seen_at`, `activity_checked_at`, `active`, `refresh_expiration`, and device observations. Historical sessions without observations report an unknown last seen. Admin target-user session reads require the admin role at both gateway and auth.

`GET /v1/items/storage-usage` preserves its item fields and adds complete component measurements for stored items, uploaded files, and retained revisions, including shared vaults owned by the account. Vaults belonging to other owners are excluded. `GET /v1/admin/users/:userUuid/storage-usage` exposes the same measurements behind both admin guards. Data bytes describe stored encrypted item representations, file object lengths, and revision encrypted content/key/hash bytes; they exclude database indexes, page allocation, and filesystem allocation overhead. Legacy item sizes are measured on read without changing the stored note. A component failure is reported as unavailable, with `complete: false` and a null total, rather than a false zero.

Home-server uses direct file/revision readers. The combined entrypoint uses its internal loopback ports automatically. Separate-container deployments set `STORAGE_USAGE_FILES_URL` and `STORAGE_USAGE_REVISIONS_URL` on syncing-server to the internal service URLs, for example `http://files:3000` and `http://revisions:3000`. Files, revisions, and syncing-server must share the existing `AUTH_JWT_SECRET` for signed internal measurements. Internal requests expire after 30 seconds, refuse redirects, and time out after 15 seconds. The shared secret is never sent to browsers.

Admin `GET /v1/admin/users/:userUuid/mfa/status` returns factor presence/counts only. `POST /v1/admin/users/:userUuid/mfa/reset` requires `intent: "reset_all_factors"` and the exact target `userUuid` in its body. It removes TOTP, recovery codes, security keys and pending challenges, disables magic-link sign-in and invalidates outstanding codes, removes trusted devices and app passwords, and revokes all durable and ephemeral sessions. Read-only admin credentials cannot perform the reset. Audit metadata records the reset scope without factor values. The legacy `DELETE /v1/admin/users/:userUuid/mfa-secret` remains a TOTP-only operation.

Full-factor resets advance an immutable account authentication generation in the same transaction as factor deletion. Session mint/refresh writes, verified login/recovery grants, and legacy JWTs are bound to that generation. An old verification coroutine cannot create a usable session after reset; delayed ephemeral cache writes are fenced again after publication and removed. Recovery-factor rotation shares the account transaction, so it cannot restore old recovery state after a reset. Ordinary user updates cannot lower the generation. Existing generation-zero sessions remain compatible until that account is reset.

Credential-cache snapshots at the public API gateway are not authorization proof: every new bearer-authenticated request validates its credential against auth, even when `CROSS_SERVICE_TOKEN_CACHE_TTL` is nonzero. This prevents a warm cache or an old in-flight cache write from restoring access after a reset. Existing requests authorized before the reset may finish. Socket commands likewise validate their session for each new command; final cross-service token signing is generation-fenced after membership/network work completes.
