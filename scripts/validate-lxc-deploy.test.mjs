import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = Object.freeze({
  installer: readFileSync(path.join(root, "deploy/lxc/install.sh"), "utf8"),
  release: readFileSync(path.join(root, "deploy/lxc/release.sh"), "utf8"),
  unit: readFileSync(
    path.join(root, "deploy/lxc/standard-red-notes.service"),
    "utf8",
  ),
  readme: readFileSync(path.join(root, "deploy/lxc/README.md"), "utf8"),
});

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function validate(files) {
  const errors = [];
  const { installer, release, unit, readme } = files;
  const stageIndex = installer.indexOf("release_create_stage");
  const smokeIndex = installer.indexOf("release_smoke_backend");
  const activateIndex = installer.indexOf("release_activate");
  const liveConfigIndex = installer.indexOf(
    'atomic_install_control "${RELEASE_FINAL}/.srn-nginx.conf"',
  );
  const liveControlIndex = installer.indexOf(
    'atomic_install_control "${RELEASE_FINAL}/.srn-launcher"',
  );
  const versionValidationIndex = installer.indexOf(
    "SRN_DEPLOY_VERSION must be 1-128 safe ASCII version characters.",
  );
  const firstMutationIndex = installer.indexOf('log "Installing OS packages"');
  const markerIndex = installer.indexOf(
    '> "${DEPLOY_ROOT}/.srn-deployment.json"',
  );
  const rollbackStart = installer.indexOf('if [ "${1:-}" = "--rollback" ]');
  const rollbackEnd = installer.indexOf('elif [ -n "${1:-}" ]', rollbackStart);
  const rollbackBlock = installer.slice(rollbackStart, rollbackEnd);
  const rollbackSuccessIndex = rollbackBlock.indexOf(
    'log "Rollback complete."',
  );
  const rollbackTargetIdentity =
    'verify_live_deployment_identity "${ROLLBACK_RELEASE}" "${ROLLBACK_REVISION}" "${ROLLBACK_VERSION}"';
  const rollbackRecoveryIdentity =
    'verify_live_deployment_identity "${ACTIVE_RELEASE}" "${ACTIVE_REVISION}" "${ACTIVE_VERSION}"';
  const oldReleaseIdentityRead =
    'read_trusted_release_identity "${OLD_RELEASE}"';
  const automaticRecoveryIdentity =
    'verify_live_deployment_identity "${OLD_RELEASE}" "${OLD_RELEASE_REVISION}" "${OLD_RELEASE_VERSION}"';
  const releaseSwap =
    'release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}"';
  const automaticRecoveryStart = installer.indexOf(
    'warn "New release was unhealthy; restoring the previous release."',
  );
  const automaticRecoveryEnd = installer.indexOf(
    '  else\n    [ -L "${CURRENT_LINK}" ]',
    automaticRecoveryStart,
  );
  const automaticRecoveryBlock = installer.slice(
    automaticRecoveryStart,
    automaticRecoveryEnd,
  );

  if (/curl[^\n]*\|\s*(?:sudo\s+)?bash/.test(installer)) {
    errors.push("remote bootstrap must never be piped into a shell");
  }
  if (
    !installer.includes("NODESOURCE_KEY_FINGERPRINT") &&
    !installer.includes("6F71F525282841EEDAF851B42F59B5F99B1BE0B4")
  ) {
    errors.push("NodeSource signing key fingerprint must be pinned");
  }
  if (
    !installer.includes('git -C "${SOURCE_DIR}" fetch --all --tags --prune')
  ) {
    errors.push("source fetch must be explicit and fail closed");
  }
  if (/git[^\n]*(?:fetch|pull)[^\n]*\|\|\s*true/.test(installer)) {
    errors.push("source update failures must not be ignored");
  }
  if (installer.includes('REPO_REF="${REPO_REF:-main}"')) {
    errors.push("deployment must not silently follow the moving main branch");
  }
  if (
    !installer.includes(
      "Symbolic REPO_REF values require EXPECTED_COMMIT=<full-sha>",
    ) ||
    !installer.includes("does not match full-SHA REPO_REF")
  ) {
    errors.push("every explicit source ref must pin the resolved commit SHA");
  }
  if (
    !installer.includes("EXPECTED_COMMIT") ||
    !installer.includes("cat-file -e")
  ) {
    errors.push("resolved refs must be verified as the expected commit object");
  }
  if (!release.includes('git -C "${source}" archive') || stageIndex < 0) {
    errors.push("builds must originate in an isolated release stage");
  }
  if (smokeIndex < stageIndex || activateIndex < smokeIndex) {
    errors.push("staging health must pass before the live switch");
  }
  if (
    versionValidationIndex < 0 ||
    versionValidationIndex > firstMutationIndex
  ) {
    errors.push("deployment version must be validated before host mutation");
  }
  if (
    markerIndex < stageIndex ||
    markerIndex > smokeIndex ||
    !installer.includes('chmod 0444 "${DEPLOY_ROOT}/.srn-deployment.json"')
  ) {
    errors.push(
      "sealed deployment marker must be generated before staged smoke",
    );
  }
  const markerLocation = installer.match(
    /location = \/\.well-known\/srn-deployment\.json \{([\s\S]*?)\n\s*\}/,
  )?.[1];
  if (
    !markerLocation ||
    !markerLocation.includes('add_header Cache-Control "no-store" always;') ||
    !markerLocation.includes("alias ${CURRENT_LINK}/.srn-deployment.json;") ||
    /try_files|proxy_pass/.test(markerLocation)
  ) {
    errors.push(
      "nginx must expose the active release marker through one exact no-store alias",
    );
  }
  if (
    occurrences(release, '"http://127.0.0.1:${port}/healthcheck/readiness"') !==
    2
  ) {
    errors.push("staged acceptance must use aggregate readiness");
  }
  if (
    !installer.includes(
      'curl -fsS --max-time 3 "http://127.0.0.1:${HTTP_PORT}/healthcheck/readiness"',
    )
  ) {
    errors.push("live acceptance must use aggregate readiness");
  }
  if (!release.includes('env -C "${release}/server/packages/home-server"')) {
    errors.push("staged backend smoke must load dotenv from home-server cwd");
  }
  if (
    !release.includes('"${release}/scripts/verify-deployment-identity.mjs"') ||
    !release.includes('--expected-revision "${DEPLOY_COMMIT}"')
  ) {
    errors.push("staged acceptance must require the exact deployment revision");
  }
  if (
    !installer.includes("verify_live_deployment_identity") ||
    !installer.includes(
      'verify_live_deployment_identity "${RELEASE_FINAL}" "${DEPLOY_COMMIT}" "${SRN_DEPLOY_VERSION}"',
    ) ||
    !installer.includes('--app-url "http://127.0.0.1:${HTTP_PORT}"')
  ) {
    errors.push(
      "live acceptance must require matching app and server deployment identity",
    );
  }
  if (
    !release.includes("release_read_deployment_identity()") ||
    !release.includes('readSealedRegularFile(".srn-release", 128)') ||
    !release.includes('readSealedRegularFile(".srn-deployment.json", 512)') ||
    !release.includes("marker.revision !== sealMatch[1]") ||
    !release.includes("releaseStat.uid !== 0") ||
    !release.includes("(releaseStat.mode & 0o222) !== 0")
  ) {
    errors.push(
      "rollback expectations must come from a root-owned sealed release identity",
    );
  }
  if (
    !rollbackBlock.includes(
      'read_trusted_release_identity "${ACTIVE_RELEASE}"',
    ) ||
    !rollbackBlock.includes(
      'read_trusted_release_identity "${ROLLBACK_RELEASE}"',
    )
  ) {
    errors.push(
      "rollback must derive both candidate and recovery expectations before switching",
    );
  }
  const rollbackTargetIdentityIndex = rollbackBlock.indexOf(
    rollbackTargetIdentity,
  );
  if (
    rollbackTargetIdentityIndex < 0 ||
    rollbackSuccessIndex < rollbackTargetIdentityIndex
  ) {
    errors.push(
      "rollback success must prove public app and server identity against the sealed target",
    );
  }
  const rollbackRecoveryIdentityIndex = rollbackBlock.indexOf(
    rollbackRecoveryIdentity,
  );
  if (
    rollbackRecoveryIdentityIndex < rollbackSuccessIndex ||
    occurrences(rollbackBlock, releaseSwap) < 2
  ) {
    errors.push(
      "failed rollback must restore and verify the formerly active sealed release",
    );
  }
  if (
    installer.indexOf(oldReleaseIdentityRead) < 0 ||
    installer.indexOf(oldReleaseIdentityRead) > activateIndex ||
    !automaticRecoveryBlock.includes(releaseSwap) ||
    !automaticRecoveryBlock.includes(automaticRecoveryIdentity)
  ) {
    errors.push(
      "automatic recovery must derive and verify the sealed previous release identity",
    );
  }
  if (
    !installer.includes("PORT=3000\nBIND_ADDRESS=127.0.0.1\nDB_TYPE=sqlite")
  ) {
    errors.push(
      "generated LXC home-server env must bind the backend to loopback",
    );
  }
  if (
    !installer.includes(
      'exec env BIND_ADDRESS=127.0.0.1 "${NODE_BIN}" --require',
    )
  ) {
    errors.push("LXC launcher must enforce a loopback backend bind");
  }
  if (
    !release.includes(
      'NODE_ENV=production PORT="${port}" BIND_ADDRESS=127.0.0.1 DB_TYPE=sqlite',
    )
  ) {
    errors.push("staged LXC backend smoke must bind only to loopback");
  }
  if (
    !installer.includes('STAGED_NGINX_SITE="${DEPLOY_ROOT}/.srn-nginx.conf"') ||
    !installer.includes('install_nginx_site "${STAGED_NGINX_SITE}"') ||
    liveConfigIndex < smokeIndex
  ) {
    errors.push("preflight must not mutate the live nginx configuration");
  }
  if (
    !installer.includes('STAGED_LAUNCHER="${DEPLOY_ROOT}/.srn-launcher"') ||
    installer.includes('cat > "${LAUNCHER}"') ||
    liveControlIndex < smokeIndex
  ) {
    errors.push("preflight must not mutate live launchers or the systemd unit");
  }
  if (
    !installer.includes(
      '"${DEPLOY_ROOT}/deploy/lxc/standard-red-notes.service" > "${STAGED_SERVICE_UNIT}"',
    )
  ) {
    errors.push(
      "staged systemd unit must come from the selected release commit",
    );
  }
  if (
    /systemctl\s+stop[^\n]*standard-red-notes\.service[^\n]*nginx/.test(
      installer,
    )
  ) {
    errors.push("failed deployment must not leave host nginx stopped");
  }
  if (!release.includes('mv -Tf -- "${temporary}" "${link}"')) {
    errors.push("the live release link must switch with one atomic rename");
  }
  if (!release.includes("release_swap_current_previous")) {
    errors.push("a previous-release rollback path is required");
  }
  if (
    !release.includes("release_restore_service_state") ||
    (installer.match(/release_restore_service_state/g) ?? []).length < 2
  ) {
    errors.push(
      "every failed live activation must restore prior service state",
    );
  }
  if (!installer.includes("restore_live_controls()")) {
    errors.push("failed activation must restore prior live control files");
  }
  if (
    !release.includes("chmod -R a-w") ||
    /chown -R[^\n]*APP_DIR/.test(installer)
  ) {
    errors.push("runtime release sources must be read only");
  }
  if (
    !unit.includes("ProtectSystem=strict") ||
    !unit.includes("ReadWritePaths=__DATA_DIR__")
  ) {
    errors.push(
      "systemd must restrict writes to the persistent data directory",
    );
  }
  if (!readme.includes("--rollback") || !readme.includes("EXPECTED_COMMIT")) {
    errors.push("operators need documented pinning and rollback procedures");
  }
  if (
    !installer.includes(
      'PUBLIC_URL_CONFIG_FILE="${PUBLIC_URL_CONFIG_DIR}/public-url"',
    ) ||
    !installer.includes('validate_public_url_origin "${PUBLIC_URL}"') ||
    !installer.includes("PUBLIC_URL=${PUBLIC_URL}")
  ) {
    errors.push(
      "LXC upgrades must persist, validate, and propagate PUBLIC_URL",
    );
  }
  if (
    installer.includes('. "${PUBLIC_URL_CONFIG_FILE}"') ||
    installer.includes('source "${PUBLIC_URL_CONFIG_FILE}"')
  ) {
    errors.push(
      "persisted PUBLIC_URL must remain inert data, never sourced as shell",
    );
  }
  const secretStorageContract = [
    'SECRETS_DIR="${PUBLIC_URL_CONFIG_DIR}/private"',
    'SECRETS_FILE="${SECRETS_DIR}/secrets.env"',
    'LEGACY_SECRETS_FILE="${DATA_DIR}/secrets.env"',
    'if [ -e "${SECRETS_DIR}" ] || [ -L "${SECRETS_DIR}" ]; then',
    'install -d -o root -g root -m 0700 "${SECRETS_DIR}"',
    '[ "$(stat -c \'%u:%a\' "${SECRETS_DIR}")" = "0:700" ]',
    'NEW_SECRETS_TEMPORARY="$(mktemp "${SECRETS_DIR}/secrets.env.create.XXXXXX")"',
    'chown root:root "${NEW_SECRETS_TEMPORARY}" && chmod 0600 "${NEW_SECRETS_TEMPORARY}"',
    'SECRETS_MODE="$(stat -c \'%a\' "${SECRETS_FILE}")"',
    'SECRETS_OWNER="$(stat -c \'%u\' "${SECRETS_FILE}")"',
  ];
  if (secretStorageContract.some((fragment) => !installer.includes(fragment))) {
    errors.push(
      "LXC secrets must live in an atomic root-owned non-symlink 0700/0600 store",
    );
  }
  const secretParserContract = [
    'mapfile -t SECRET_ASSIGNMENTS < <(grep -E "^${name}=" "${file}" || true)',
    '[ "${#SECRET_ASSIGNMENTS[@]}" -le 1 ]',
    '[[ "${line}" =~ ^(AUTH_JWT_SECRET|JWT_SECRET|ENCRYPTION_SERVER_KEY|PSEUDO_KEY_PARAMS_KEY|VALET_TOKEN_SECRET|WEB_SOCKET_CONNECTION_TOKEN_SECRET|WEBSOCKET_GATEWAY_INTERNAL_SECRET|ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY)=[0-9a-fA-F]{64}$ ]]',
    '[ "${assignment_count}" = 5 ] || [ "${assignment_count}" = 6 ]',
    'validate_secret_document "${LEGACY_SECRETS_FILE}"',
    'validate_secret_document "${SECRETS_FILE}"',
  ];
  if (secretParserContract.some((fragment) => !installer.includes(fragment))) {
    errors.push(
      "LXC secrets must use an exact inert allow-list parser with duplicate rejection",
    );
  }
  const secretMigrationContract = [
    'CURRENT_HOME_ENV="${CURRENT_LINK}/server/packages/home-server/.env"',
    '[ "$(stat -c \'%a\' "${LEGACY_SECRETS_FILE}")" = 600 ]',
    '[ "${LEGACY_SECRETS_OWNER}" = 0 ] || [ "${LEGACY_SECRETS_OWNER}" = "${APP_UID}" ]',
    'MIGRATION_TEMPORARY="$(mktemp "${SECRETS_DIR}/secrets.env.migrate.XXXXXX")"',
    'printf -v "MIGRATION_${REQUIRED_LEGACY_SECRET}" \'%s\' "${READ_SECRET_VALUE}"',
    'MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET_STATE="${READ_SECRET_STATE}"',
    'MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET_STATE="${READ_SECRET_STATE}"',
    'append_migrated_optional_secret "${MIGRATION_TEMPORARY}" WEB_SOCKET_CONNECTION_TOKEN_SECRET',
    'append_migrated_optional_secret "${MIGRATION_TEMPORARY}" WEBSOCKET_GATEWAY_INTERNAL_SECRET',
    'mv -Tf -- "${MIGRATION_TEMPORARY}" "${SECRETS_FILE}"',
    'die "Root-owned ${REQUIRED_LEGACY_SECRET} failed post-migration verification."',
    'verify_migrated_optional_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET',
    'verify_migrated_optional_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET',
    'die "Refusing to remove legacy ${LEGACY_SECRET_NAME}: it differs from root-owned storage."',
    "for OPTIONAL_LEGACY_SECRET_NAME in WEB_SOCKET_CONNECTION_TOKEN_SECRET WEBSOCKET_GATEWAY_INTERNAL_SECRET ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY; do",
    'rm -f -- "${LEGACY_SECRETS_FILE}"',
  ];
  const legacyOwnerGuard =
    '[ "${LEGACY_SECRETS_OWNER}" = 0 ] || [ "${LEGACY_SECRETS_OWNER}" = "${APP_UID}" ]';
  if (
    secretMigrationContract.some((fragment) => !installer.includes(fragment)) ||
    occurrences(installer, legacyOwnerGuard) !== 2 ||
    installer.includes(
      'install -o root -g root -m 0600 "${LEGACY_SECRETS_FILE}" "${SECRETS_FILE}"',
    )
  ) {
    errors.push(
      "LXC legacy-secret migration must safely accept the old app-owned format, canonically rewrite it, and verify root-owned output",
    );
  }
  const assistantPairingContract = [
    'ASSISTANT_SUBSCRIPTION_TOKEN_PATH="${DATA_DIR}/assistant-subscription.json"',
    'read_hex_secret "${SECRETS_FILE}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY false',
    'persist_assistant_secret "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"',
    'verify_pairing_store "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"',
    "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}",
    "ASSISTANT_SUBSCRIPTION_TOKEN_PATH=${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}",
  ];
  if (
    assistantPairingContract.some((fragment) => !installer.includes(fragment))
  ) {
    errors.push(
      "LXC must generate, validate, preserve, authenticate, and durably route the internal assistant pairing secret",
    );
  }
  const webSocketSyncContract = [
    '\npersist_missing_websocket_secrets\nvalidate_secret_document "${SECRETS_FILE}"',
    'read_hex_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET true',
    'read_hex_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET true',
    "WEB_SOCKET_CONNECTION_TOKEN_SECRET=${WEB_SOCKET_CONNECTION_TOKEN_SECRET}",
    "WEBSOCKET_GATEWAY_INTERNAL_SECRET=${WEBSOCKET_GATEWAY_INTERNAL_SECRET}",
    "REDIS_HOST=${REDIS_HOST}",
    "REDIS_PORT=${REDIS_PORT}",
    "WEBSOCKET_SYNC_ENABLED=${WEBSOCKET_SYNC_ENABLED}",
    "WEBSOCKET_SYNC_ALLOWED_ORIGINS=${WEBSOCKET_SYNC_ALLOWED_ORIGINS}",
    "WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER=${WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER}",
    "WEBSOCKET_SYNC_REDIS_KEY_PREFIX=${WEBSOCKET_SYNC_REDIS_KEY_PREFIX}",
    "WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS=${WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS}",
    "WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS=${WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS}",
    "WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS=${WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS}",
  ];
  if (webSocketSyncContract.some((fragment) => !installer.includes(fragment))) {
    errors.push(
      "LXC must preserve WebSocket secrets and propagate fail-closed sync configuration",
    );
  }
  const fileDownloadDeadlineContract = [
    'FILE_DOWNLOAD_DEADLINE_MS="${FILE_DOWNLOAD_DEADLINE_MS:-30000}"',
    'validate_positive_safe_integer FILE_DOWNLOAD_DEADLINE_MS "${FILE_DOWNLOAD_DEADLINE_MS}"',
    "FILE_DOWNLOAD_DEADLINE_MS=${FILE_DOWNLOAD_DEADLINE_MS}",
  ];
  if (
    fileDownloadDeadlineContract.some(
      (fragment) => !installer.includes(fragment),
    )
  ) {
    errors.push(
      "LXC must validate and propagate the operator-overridable file-download deadline",
    );
  }
  const socketLocation = installer.match(
    /location \/sockets \{([\s\S]*?)\n  \}/,
  )?.[1];
  const webSocketProxyContract = [
    "proxy_pass http://127.0.0.1:3000;",
    "proxy_http_version 1.1;",
    "proxy_set_header Upgrade \\$http_upgrade;",
    "proxy_set_header Connection \\$connection_upgrade;",
    "proxy_set_header Host \\$host;",
    "proxy_read_timeout 86400s;",
    "proxy_send_timeout 86400s;",
  ];
  if (
    occurrences(installer, "location /sockets {") !== 1 ||
    !installer.includes(
      "map \\$http_upgrade \\$connection_upgrade { default upgrade; '' close; }",
    ) ||
    !socketLocation ||
    webSocketProxyContract.some(
      (fragment) => !socketLocation.includes(fragment),
    )
  ) {
    errors.push(
      "LXC nginx must preserve WebSocket upgrades and long-lived /sockets proxy timeouts",
    );
  }
  if (
    installer.includes('. "${SECRETS_FILE}"') ||
    installer.includes('source "${SECRETS_FILE}"') ||
    installer.includes('. "${LEGACY_SECRETS_FILE}"') ||
    installer.includes('source "${LEGACY_SECRETS_FILE}"')
  ) {
    errors.push(
      "persistent LXC secrets must be parsed as inert data, never sourced as shell",
    );
  }
  if (
    !readme.includes(
      "creates the assistant pairing-encryption key internally",
    ) ||
    !readme.includes("instead of generating a replacement")
  ) {
    errors.push(
      "LXC operators need automatic pairing-key and fail-closed recovery guidance",
    );
  }
  const normalizedReadme = readme.replace(/\s+/g, " ");
  if (
    !normalizedReadme.includes(
      "without Redis authentication or TLS, so the Redis endpoint must stay on the same private trusted network",
    ) ||
    !normalizedReadme.includes("FILE_DOWNLOAD_DEADLINE_MS") ||
    !normalizedReadme.includes(
      "rejects zero, negative, fractional, or unsafe integer values",
    )
  ) {
    errors.push(
      "LXC operators need the external-Redis trust boundary and file-download deadline documented",
    );
  }
  if (
    occurrences(installer, "proxy_set_header X-Forwarded-Proto \\$scheme;") !==
      3 ||
    installer.includes("ENFORCE_HTTPS_FROM_PROXY") ||
    installer.includes("srn_hsts_header") ||
    installer.includes("srn_redirect_to_https")
  ) {
    errors.push(
      "LXC must leave HTTPS redirect and HSTS enforcement to its outer proxy",
    );
  }
  return errors;
}

function mutate(file, from, to = "") {
  assert.ok(baseline[file].includes(from), `fixture text missing in ${file}`);
  return { ...baseline, [file]: baseline[file].replace(from, to) };
}

test("LXC deployment satisfies the staged, atomic, fail-closed contract", () => {
  assert.deepEqual(validate(baseline), []);
});

test("LXC secret contract rejects unsafe parsing, paths, permissions, and migration", () => {
  for (const [fragment, expected] of [
    [
      'if [ -e "${SECRETS_DIR}" ] || [ -L "${SECRETS_DIR}" ]; then',
      /non-symlink/,
    ],
    ['[ "$(stat -c \'%u:%a\' "${SECRETS_DIR}")" = "0:700" ]', /0700\/0600/],
    ['[ "${#SECRET_ASSIGNMENTS[@]}" -le 1 ]', /duplicate rejection/],
    [
      '[[ "${line}" =~ ^(AUTH_JWT_SECRET|JWT_SECRET|ENCRYPTION_SERVER_KEY|PSEUDO_KEY_PARAMS_KEY|VALET_TOKEN_SECRET|WEB_SOCKET_CONNECTION_TOKEN_SECRET|WEBSOCKET_GATEWAY_INTERNAL_SECRET|ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY)=[0-9a-fA-F]{64}$ ]]',
      /allow-list parser/,
    ],
    [
      '[ "${LEGACY_SECRETS_OWNER}" = 0 ] || [ "${LEGACY_SECRETS_OWNER}" = "${APP_UID}" ]',
      /old app-owned format/,
    ],
    [
      'die "Root-owned ${REQUIRED_LEGACY_SECRET} failed post-migration verification."',
      /verify root-owned output/,
    ],
    [
      'append_migrated_optional_secret "${MIGRATION_TEMPORARY}" WEB_SOCKET_CONNECTION_TOKEN_SECRET',
      /canonically rewrite/,
    ],
    [
      'verify_migrated_optional_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET',
      /verify root-owned output/,
    ],
    [
      "for OPTIONAL_LEGACY_SECRET_NAME in WEB_SOCKET_CONNECTION_TOKEN_SECRET WEBSOCKET_GATEWAY_INTERNAL_SECRET ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY; do",
      /canonically rewrite/,
    ],
  ]) {
    assert.match(validate(mutate("installer", fragment)).join("\n"), expected);
  }
});

test("LXC secret parser treats legacy content as inert exact data", () => {
  const start = baseline.installer.indexOf("read_hex_secret() {");
  const end = baseline.installer.indexOf("\npersist_assistant_secret()", start);
  assert.ok(start >= 0 && end > start);
  const definitions = baseline.installer.slice(start, end);
  const key = "a".repeat(64);

  const run = (lines, command) =>
    spawnSync("bash", ["-s"], {
      input: [
        "set -euo pipefail",
        'die() { printf "%s\\n" "$*" >&2; exit 90; }',
        definitions,
        'sandbox="$(mktemp -d)"',
        "trap 'rm -rf -- \"${sandbox}\"' EXIT",
        ...lines.map(
          (line) => `printf '%s\\n' '${line}' >> "\${sandbox}/secrets.env"`,
        ),
        command,
      ].join("\n"),
      cwd: root,
      encoding: "utf8",
    });

  const base = [
    `AUTH_JWT_SECRET=${key}`,
    `JWT_SECRET=${key}`,
    `ENCRYPTION_SERVER_KEY=${key}`,
    `PSEUDO_KEY_PARAMS_KEY=${key}`,
    `VALET_TOKEN_SECRET=${key}`,
  ];
  assert.equal(
    run(base, 'validate_secret_document "${sandbox}/secrets.env"').status,
    0,
  );

  assert.equal(
    run(
      [
        ...base,
        `WEB_SOCKET_CONNECTION_TOKEN_SECRET=${key}`,
        `WEBSOCKET_GATEWAY_INTERNAL_SECRET=${key}`,
        `ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${key}`,
      ],
      'validate_secret_document "${sandbox}/secrets.env"',
    ).status,
    0,
  );

  const malicious = run(
    [...base, 'EVIL=$(touch "${sandbox}/executed")'],
    'validate_secret_document "${sandbox}/secrets.env"',
  );
  assert.equal(malicious.status, 90, malicious.stderr);

  const duplicate = run(
    [...base, `AUTH_JWT_SECRET=${key}`],
    'validate_secret_document "${sandbox}/secrets.env"; read_hex_secret "${sandbox}/secrets.env" AUTH_JWT_SECRET true',
  );
  assert.equal(duplicate.status, 90, duplicate.stderr);

  const connectionKey = "b".repeat(64);
  const internalKey = "c".repeat(64);
  const preserved = run(
    [],
    [
      ': > "${sandbox}/migrated.env"',
      'append_migrated_optional_secret "${sandbox}/migrated.env" WEB_SOCKET_CONNECTION_TOKEN_SECRET valid ' +
        connectionKey,
      'append_migrated_optional_secret "${sandbox}/migrated.env" WEBSOCKET_GATEWAY_INTERNAL_SECRET valid ' +
        internalKey,
      'verify_migrated_optional_secret "${sandbox}/migrated.env" WEB_SOCKET_CONNECTION_TOKEN_SECRET valid ' +
        connectionKey,
      'verify_migrated_optional_secret "${sandbox}/migrated.env" WEBSOCKET_GATEWAY_INTERNAL_SECRET valid ' +
        internalKey,
      `grep -Fxq "WEB_SOCKET_CONNECTION_TOKEN_SECRET=${connectionKey}" "\${sandbox}/migrated.env"`,
      `grep -Fxq "WEBSOCKET_GATEWAY_INTERNAL_SECRET=${internalKey}" "\${sandbox}/migrated.env"`,
    ].join("\n"),
  );
  assert.equal(preserved.status, 0, preserved.stderr);

  const mismatched = run(
    [],
    [
      ': > "${sandbox}/migrated.env"',
      'append_migrated_optional_secret "${sandbox}/migrated.env" WEB_SOCKET_CONNECTION_TOKEN_SECRET valid ' +
        connectionKey,
      'verify_migrated_optional_secret "${sandbox}/migrated.env" WEB_SOCKET_CONNECTION_TOKEN_SECRET valid ' +
        "d".repeat(64),
    ].join("\n"),
  );
  assert.equal(mismatched.status, 90, mismatched.stderr);
});

test("LXC file-download deadline accepts only positive safe integers", () => {
  const start = baseline.installer.indexOf(
    "validate_positive_safe_integer() {",
  );
  const end = baseline.installer.indexOf(
    "\nvalidate_positive_safe_integer FILE_DOWNLOAD_DEADLINE_MS",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const definition = baseline.installer.slice(start, end);
  const run = (value) =>
    spawnSync("bash", ["-s"], {
      input: [
        "set -euo pipefail",
        'die() { printf "%s\\n" "$*" >&2; exit 90; }',
        definition,
        `validate_positive_safe_integer FILE_DOWNLOAD_DEADLINE_MS '${value}'`,
      ].join("\n"),
      cwd: root,
      encoding: "utf8",
    });

  for (const value of ["30000", "9007199254740991"]) {
    const result = run(value);
    assert.equal(result.status, 0, result.stderr);
  }
  for (const value of ["", "0", "01", "-1", "1.5", "9007199254740992"]) {
    const result = run(value);
    assert.equal(result.status, 90, `${value}: ${result.stderr}`);
  }
});

test("LXC requires the full WebSocket, download deadline, and proxy matrix", () => {
  for (const fragment of [
    '\npersist_missing_websocket_secrets\nvalidate_secret_document "${SECRETS_FILE}"',
    "REDIS_HOST=${REDIS_HOST}",
    "REDIS_PORT=${REDIS_PORT}",
    "WEBSOCKET_SYNC_ENABLED=${WEBSOCKET_SYNC_ENABLED}",
    "WEBSOCKET_SYNC_ALLOWED_ORIGINS=${WEBSOCKET_SYNC_ALLOWED_ORIGINS}",
    "WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER=${WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER}",
    "WEBSOCKET_SYNC_REDIS_KEY_PREFIX=${WEBSOCKET_SYNC_REDIS_KEY_PREFIX}",
    "WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS=${WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS}",
    "WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS=${WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS}",
    "WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS=${WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS}",
  ]) {
    assert.match(
      validate(mutate("installer", fragment)).join("\n"),
      /propagate fail-closed sync configuration/,
    );
  }

  for (const fragment of [
    'FILE_DOWNLOAD_DEADLINE_MS="${FILE_DOWNLOAD_DEADLINE_MS:-30000}"',
    'validate_positive_safe_integer FILE_DOWNLOAD_DEADLINE_MS "${FILE_DOWNLOAD_DEADLINE_MS}"',
    "FILE_DOWNLOAD_DEADLINE_MS=${FILE_DOWNLOAD_DEADLINE_MS}",
  ]) {
    assert.match(
      validate(mutate("installer", fragment)).join("\n"),
      /validate and propagate the operator-overridable file-download deadline/,
    );
  }

  for (const fragment of [
    "map \\$http_upgrade \\$connection_upgrade { default upgrade; '' close; }",
    "location /sockets {",
    "proxy_set_header Upgrade \\$http_upgrade;",
    "proxy_set_header Connection \\$connection_upgrade;",
    "proxy_read_timeout 86400s;",
    "proxy_send_timeout 86400s;",
  ]) {
    assert.match(
      validate(mutate("installer", fragment)).join("\n"),
      /preserve WebSocket upgrades and long-lived \/sockets proxy timeouts/,
    );
  }

  for (const fragment of [
    "same private trusted network",
    "FILE_DOWNLOAD_DEADLINE_MS",
    "rejects zero, negative, fractional, or unsafe integer values",
  ]) {
    assert.match(
      validate(mutate("readme", fragment)).join("\n"),
      /external-Redis trust boundary and file-download deadline documented/,
    );
  }
});

test("LXC release links activate and roll back to the retained target", () => {
  const result = spawnSync("bash", ["-s"], {
    input: [
      "set -euo pipefail",
      "source deploy/lxc/release.sh",
      'sandbox="${PWD}/.tmp-srn-lxc-test-$$"',
      'case "${sandbox}" in "${PWD}"/.tmp-srn-lxc-test-*) ;; *) exit 97 ;; esac',
      'mkdir "${sandbox}"',
      "trap 'rm -rf -- \"${sandbox}\"' EXIT",
      'releases="${sandbox}/releases"',
      'mkdir -p "${releases}/one" "${releases}/two"',
      ': > "${releases}/one/.srn-release"',
      ': > "${releases}/two/.srn-release"',
      'release_atomic_link "${releases}/one" "${sandbox}/current"',
      'release_activate "${releases}/two" "${sandbox}/current" "${sandbox}/previous" "${releases}"',
      'test "$(readlink -f "${sandbox}/current")" = "$(readlink -f "${releases}/two")"',
      'test "$(readlink -f "${sandbox}/previous")" = "$(readlink -f "${releases}/one")"',
      'release_swap_current_previous "${sandbox}/current" "${sandbox}/previous" "${releases}"',
      'test "$(readlink -f "${sandbox}/current")" = "$(readlink -f "${releases}/one")"',
      'test "$(readlink -f "${sandbox}/previous")" = "$(readlink -f "${releases}/two")"',
    ].join("\n"),
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC rollback restores both links when the second rename fails", () => {
  const result = spawnSync("bash", ["-s"], {
    input: [
      "set -euo pipefail",
      "source deploy/lxc/release.sh",
      'sandbox="${PWD}/.tmp-srn-lxc-failure-$$"',
      'case "${sandbox}" in "${PWD}"/.tmp-srn-lxc-failure-*) ;; *) exit 97 ;; esac',
      'mkdir "${sandbox}"',
      "trap 'rm -rf -- \"${sandbox}\"' EXIT",
      'releases="${sandbox}/releases"',
      'mkdir -p "${releases}/one" "${releases}/two"',
      ': > "${releases}/one/.srn-release"',
      ': > "${releases}/two/.srn-release"',
      'release_atomic_link "${releases}/two" "${sandbox}/current"',
      'release_atomic_link "${releases}/one" "${sandbox}/previous"',
      "mv_calls=0",
      'mv() { mv_calls=$((mv_calls + 1)); [ "${mv_calls}" -ne 2 ] || return 1; command mv "$@"; }',
      'if release_swap_current_previous "${sandbox}/current" "${sandbox}/previous" "${releases}"; then exit 98; fi',
      "unset -f mv",
      'test "$(readlink -f "${sandbox}/current")" = "$(readlink -f "${releases}/two")"',
      'test "$(readlink -f "${sandbox}/previous")" = "$(readlink -f "${releases}/one")"',
    ].join("\n"),
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC recovery preserves disabled and inactive service state", () => {
  const result = spawnSync("bash", ["-s"], {
    input: [
      "set -euo pipefail",
      "source deploy/lxc/release.sh",
      'sandbox="${PWD}/.tmp-srn-service-state-$$"',
      'mkdir "${sandbox}"',
      "trap 'rm -rf -- \"${sandbox}\"' EXIT",
      'calls="${sandbox}/calls"',
      'systemctl() { printf "systemctl %s\\n" "$*" >> "${calls}"; }',
      'nginx() { printf "nginx %s\\n" "$*" >> "${calls}"; }',
      "release_restore_service_state true false false false",
      '! grep -q "systemctl enable\|systemctl restart" "${calls}"',
      'grep -qx "systemctl disable standard-red-notes.service" "${calls}"',
      'grep -qx "systemctl stop standard-red-notes.service" "${calls}"',
      'grep -qx "systemctl stop nginx" "${calls}"',
      'grep -qx "nginx -t" "${calls}"',
    ].join("\n"),
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC recovery stops a newly loaded service before forgetting an absent prior unit", () => {
  const result = spawnSync("bash", ["-s"], {
    input: [
      "set -euo pipefail",
      "source deploy/lxc/release.sh",
      'sandbox="${PWD}/.tmp-srn-absent-unit-$$"',
      'mkdir "${sandbox}"',
      "trap 'rm -rf -- \"${sandbox}\"' EXIT",
      'calls="${sandbox}/calls"',
      "service_active=true",
      "systemctl() {",
      '  printf "systemctl %s\\n" "$*" >> "${calls}"',
      '  if [ "$1" = stop ] && [ "${2:-}" = standard-red-notes.service ]; then service_active=false; fi',
      '  if [ "$1" = is-active ]; then [ "${service_active}" = true ]; return; fi',
      "  return 0",
      "}",
      'nginx() { printf "nginx %s\\n" "$*" >> "${calls}"; }',
      "release_restore_service_state false false false false",
      '[ "${service_active}" = false ]',
      'test "$(sed -n \'1p\' "${calls}")" = "systemctl stop standard-red-notes.service"',
      'test "$(sed -n \'2p\' "${calls}")" = "systemctl disable standard-red-notes.service"',
      'test "$(sed -n \'3p\' "${calls}")" = "systemctl daemon-reload"',
      'test "$(sed -n \'4p\' "${calls}")" = "systemctl is-active --quiet standard-red-notes.service"',
    ].join("\n"),
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC contract rejects moving refs and masked source failures", () => {
  assert.match(
    validate(
      mutate(
        "installer",
        'REPO_REF="${REPO_REF:-}"',
        'REPO_REF="${REPO_REF:-main}"',
      ),
    ).join("\n"),
    /moving main branch/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        'git -C "${SOURCE_DIR}" fetch --all --tags --prune',
        'git -C "${SOURCE_DIR}" fetch --all --tags --prune || true',
      ),
    ).join("\n"),
    /source update failures/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        'die "Symbolic REPO_REF values require EXPECTED_COMMIT=<full-sha>."',
      ),
    ).join("\n"),
    /pin the resolved commit SHA/,
  );
});

test("LXC contract rejects lost staging, health, atomic switch, and rollback", () => {
  for (const [file, text, error] of [
    ["release", 'git -C "${source}" archive', "isolated release stage"],
    ["installer", "release_smoke_backend", "staging health"],
    ["release", 'mv -Tf -- "${temporary}" "${link}"', "atomic rename"],
    ["release", "release_swap_current_previous", "rollback path"],
  ]) {
    assert.match(validate(mutate(file, text)).join("\n"), new RegExp(error));
  }
});

test("LXC staged and live acceptance reject liveness-only probes", () => {
  assert.match(
    validate(
      mutate(
        "release",
        '"http://127.0.0.1:${port}/healthcheck/readiness"',
        '"http://127.0.0.1:${port}/healthcheck"',
      ),
    ).join("\n"),
    /staged acceptance must use aggregate readiness/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        '"http://127.0.0.1:${HTTP_PORT}/healthcheck/readiness"',
        '"http://127.0.0.1:${HTTP_PORT}/healthcheck"',
      ),
    ).join("\n"),
    /live acceptance must use aggregate readiness/,
  );
});

test("LXC deployment identity is sealed, uncached, and exact before activation", () => {
  for (const [file, from, to, expected] of [
    [
      "installer",
      'chmod 0444 "${DEPLOY_ROOT}/.srn-deployment.json"',
      'chmod 0644 "${DEPLOY_ROOT}/.srn-deployment.json"',
      /sealed deployment marker/,
    ],
    [
      "installer",
      'add_header Cache-Control "no-store" always;',
      'add_header Cache-Control "max-age=3600" always;',
      /exact no-store alias/,
    ],
    [
      "installer",
      "alias ${CURRENT_LINK}/.srn-deployment.json;",
      "try_files $uri /index.html;",
      /exact no-store alias/,
    ],
    [
      "release",
      '--expected-revision "${DEPLOY_COMMIT}"',
      '--expected-revision "unknown"',
      /staged acceptance must require the exact deployment revision/,
    ],
    [
      "installer",
      'verify_live_deployment_identity "${RELEASE_FINAL}" "${DEPLOY_COMMIT}" "${SRN_DEPLOY_VERSION}"',
      "true",
      /live acceptance must require matching app and server deployment identity/,
    ],
  ]) {
    assert.match(validate(mutate(file, from, to)).join("\n"), expected);
  }

  const markerStart = baseline.installer.indexOf(
    'printf \'{"revision":"%s","version":"%s"}\\n\'',
  );
  const markerLastLine = 'chmod 0444 "${DEPLOY_ROOT}/.srn-deployment.json"';
  const markerEnd =
    baseline.installer.indexOf(
      "\n",
      baseline.installer.indexOf(markerLastLine),
    ) + 1;
  const markerBlock = baseline.installer.slice(markerStart, markerEnd);
  const movedMarker = {
    ...baseline,
    installer: `${baseline.installer.slice(0, markerStart)}${baseline.installer.slice(markerEnd)}\n${markerBlock}`,
  };
  assert.match(validate(movedMarker).join("\n"), /sealed deployment marker/);
});

test("LXC rollback and recovery fail closed on sealed identity mismatch", () => {
  for (const [file, from, to, expected] of [
    [
      "release",
      "marker.revision !== sealMatch[1]",
      "false",
      /root-owned sealed release identity/,
    ],
    [
      "installer",
      'read_trusted_release_identity "${ROLLBACK_RELEASE}"',
      'read_trusted_release_identity "${ACTIVE_RELEASE}"',
      /derive both candidate and recovery expectations/,
    ],
    [
      "installer",
      'verify_live_deployment_identity "${ROLLBACK_RELEASE}" "${ROLLBACK_REVISION}" "${ROLLBACK_VERSION}"',
      "true",
      /rollback success must prove public app and server identity/,
    ],
    [
      "installer",
      'verify_live_deployment_identity "${ACTIVE_RELEASE}" "${ACTIVE_REVISION}" "${ACTIVE_VERSION}"',
      "true",
      /failed rollback must restore and verify/,
    ],
    [
      "installer",
      'warn "Rollback target was unhealthy; restoring the release that was active."\n  release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}"',
      'warn "Rollback target was unhealthy; restoring the release that was active."\n  true',
      /failed rollback must restore and verify/,
    ],
    [
      "installer",
      'read_trusted_release_identity "${OLD_RELEASE}"',
      "true",
      /automatic recovery must derive and verify/,
    ],
    [
      "installer",
      'verify_live_deployment_identity "${OLD_RELEASE}" "${OLD_RELEASE_REVISION}" "${OLD_RELEASE_VERSION}"',
      "true",
      /automatic recovery must derive and verify/,
    ],
    [
      "installer",
      'warn "New release was unhealthy; restoring the previous release."\n  if [ -n "${OLD_RELEASE}" ]; then\n    release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}"',
      'warn "New release was unhealthy; restoring the previous release."\n  if [ -n "${OLD_RELEASE}" ]; then\n    true',
      /automatic recovery must derive and verify/,
    ],
  ]) {
    assert.match(validate(mutate(file, from, to)).join("\n"), expected);
  }
});

test("LXC contract persists public origin without trusting forwarded transport", () => {
  for (const [from, to, error] of [
    [
      'PUBLIC_URL_CONFIG_FILE="${PUBLIC_URL_CONFIG_DIR}/public-url"',
      'PUBLIC_URL_CONFIG_FILE="${DEPLOY_ROOT}/public-url"',
      "persist, validate, and propagate PUBLIC_URL",
    ],
    [
      'validate_public_url_origin "${PUBLIC_URL}"',
      'test -n "${PUBLIC_URL}"',
      "persist, validate, and propagate PUBLIC_URL",
    ],
    [
      "PUBLIC_URL=${PUBLIC_URL}",
      "PUBLIC_URL=",
      "persist, validate, and propagate PUBLIC_URL",
    ],
    [
      "proxy_set_header X-Forwarded-Proto \\$scheme;",
      "proxy_set_header X-Forwarded-Proto \\$http_x_forwarded_proto;",
      "outer proxy",
    ],
  ]) {
    assert.match(
      validate(mutate("installer", from, to)).join("\n"),
      new RegExp(error),
    );
  }
  assert.match(
    validate({
      ...baseline,
      installer: `${baseline.installer}\n. "\${PUBLIC_URL_CONFIG_FILE}"`,
    }).join("\n"),
    /never sourced as shell/,
  );
});

test("LXC preflight keeps live link and nginx config untouched", () => {
  assert.match(
    validate(
      mutate(
        "installer",
        'STAGED_NGINX_SITE="${DEPLOY_ROOT}/.srn-nginx.conf"',
        'STAGED_NGINX_SITE="${NGINX_SITE}"',
      ),
    ).join("\n"),
    /must not mutate the live nginx configuration/,
  );
  assert.match(
    validate(mutate("installer", "release_smoke_backend")).join("\n"),
    /staging health must pass before the live switch/,
  );
  assert.match(
    validate(mutate("installer", "restore_live_controls()")).join("\n"),
    /restore prior live control files/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        'STAGED_LAUNCHER="${DEPLOY_ROOT}/.srn-launcher"',
        'STAGED_LAUNCHER="${LAUNCHER}"',
      ),
    ).join("\n"),
    /must not mutate live launchers/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        '"${DEPLOY_ROOT}/deploy/lxc/standard-red-notes.service" > "${STAGED_SERVICE_UNIT}"',
        '"${UNIT_SRC_DIR}/standard-red-notes.service" > "${STAGED_SERVICE_UNIT}"',
      ),
    ).join("\n"),
    /selected release commit/,
  );
  assert.match(
    validate({
      ...baseline,
      installer: `${baseline.installer}\nsystemctl stop standard-red-notes.service nginx`,
    }).join("\n"),
    /must not leave host nginx stopped/,
  );
  assert.match(
    validate(mutate("installer", "release_restore_service_state")).join("\n"),
    /restore prior service state/,
  );
});

test("LXC smoke starts from the staged home-server working directory", () => {
  assert.match(
    validate(
      mutate(
        "release",
        'env -C "${release}/server/packages/home-server"',
        "env",
      ),
    ).join("\n"),
    /load dotenv from home-server cwd/,
  );
});

test("LXC generated env, launcher, and staged smoke pin the backend to loopback", () => {
  assert.match(
    validate(
      mutate(
        "installer",
        "PORT=3000\nBIND_ADDRESS=127.0.0.1\nDB_TYPE=sqlite",
        "PORT=3000\nBIND_ADDRESS=0.0.0.0\nDB_TYPE=sqlite",
      ),
    ).join("\n"),
    /generated LXC home-server env must bind the backend to loopback/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        'exec env BIND_ADDRESS=127.0.0.1 "${NODE_BIN}" --require',
        'exec env BIND_ADDRESS=0.0.0.0 "${NODE_BIN}" --require',
      ),
    ).join("\n"),
    /LXC launcher must enforce a loopback backend bind/,
  );
  assert.match(
    validate(
      mutate(
        "release",
        'NODE_ENV=production PORT="${port}" BIND_ADDRESS=127.0.0.1 DB_TYPE=sqlite',
        'NODE_ENV=production PORT="${port}" BIND_ADDRESS=0.0.0.0 DB_TYPE=sqlite',
      ),
    ).join("\n"),
    /staged LXC backend smoke must bind only to loopback/,
  );
});

test("LXC contract rejects writable runtime source and remote shell bootstrap", () => {
  assert.match(
    validate(mutate("release", "chmod -R a-w")).join("\n"),
    /read only/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        "curl --proto '=https' --tlsv1.2 -fsSL \\",
        "curl -fsSL https://deb.nodesource.com/setup_26.x | bash #",
      ),
    ).join("\n"),
    /piped into a shell/,
  );
});
