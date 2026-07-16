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
