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

  if (/curl[^\n]*\|\s*(?:sudo\s+)?bash/.test(installer)) {
    errors.push("remote bootstrap must never be piped into a shell");
  }
  if (
    !installer.includes("NODESOURCE_KEY_FINGERPRINT") &&
    !installer.includes("6F71F525282841EEDAF851B42F59B5F99B1BE0B4")
  ) {
    errors.push("NodeSource signing key fingerprint must be pinned");
  }
  if (!installer.includes("git -C \"${SOURCE_DIR}\" fetch --all --tags --prune")) {
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
      'Symbolic REPO_REF values require EXPECTED_COMMIT=<full-sha>',
    ) ||
    !installer.includes("does not match full-SHA REPO_REF")
  ) {
    errors.push("every explicit source ref must pin the resolved commit SHA");
  }
  if (!installer.includes("EXPECTED_COMMIT") || !installer.includes("cat-file -e")) {
    errors.push("resolved refs must be verified as the expected commit object");
  }
  if (!release.includes("git -C \"${source}\" archive") || stageIndex < 0) {
    errors.push("builds must originate in an isolated release stage");
  }
  if (smokeIndex < stageIndex || activateIndex < smokeIndex) {
    errors.push("staging health must pass before the live switch");
  }
  if (!release.includes('"http://127.0.0.1:${port}/healthcheck/readiness"')) {
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
    errors.push("staged systemd unit must come from the selected release commit");
  }
  if (/systemctl\s+stop[^\n]*standard-red-notes\.service[^\n]*nginx/.test(installer)) {
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
    errors.push("every failed live activation must restore prior service state");
  }
  if (!installer.includes("restore_live_controls()")) {
    errors.push("failed activation must restore prior live control files");
  }
  if (!release.includes("chmod -R a-w") || /chown -R[^\n]*APP_DIR/.test(installer)) {
    errors.push("runtime release sources must be read only");
  }
  if (!unit.includes("ProtectSystem=strict") || !unit.includes("ReadWritePaths=__DATA_DIR__")) {
    errors.push("systemd must restrict writes to the persistent data directory");
  }
  if (!readme.includes("--rollback") || !readme.includes("EXPECTED_COMMIT")) {
    errors.push("operators need documented pinning and rollback procedures");
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

test("LXC release links activate and roll back to the retained target", () => {
  const result = spawnSync(
    "bash",
    ["-s"],
    {
      input: [
        "set -euo pipefail",
        "source deploy/lxc/release.sh",
        'sandbox="${PWD}/.tmp-srn-lxc-test-$$"',
        'case "${sandbox}" in "${PWD}"/.tmp-srn-lxc-test-*) ;; *) exit 97 ;; esac',
        'mkdir "${sandbox}"',
        'trap \'rm -rf -- "${sandbox}"\' EXIT',
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
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC rollback restores both links when the second rename fails", () => {
  const result = spawnSync(
    "bash",
    ["-s"],
    {
      input: [
        "set -euo pipefail",
        "source deploy/lxc/release.sh",
        'sandbox="${PWD}/.tmp-srn-lxc-failure-$$"',
        'case "${sandbox}" in "${PWD}"/.tmp-srn-lxc-failure-*) ;; *) exit 97 ;; esac',
        'mkdir "${sandbox}"',
        'trap \'rm -rf -- "${sandbox}"\' EXIT',
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
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC recovery preserves disabled and inactive service state", () => {
  const result = spawnSync(
    "bash",
    ["-s"],
    {
      input: [
        "set -euo pipefail",
        "source deploy/lxc/release.sh",
        'sandbox="${PWD}/.tmp-srn-service-state-$$"',
        'mkdir "${sandbox}"',
        'trap \'rm -rf -- "${sandbox}"\' EXIT',
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
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC recovery stops a newly loaded service before forgetting an absent prior unit", () => {
  const result = spawnSync(
    "bash",
    ["-s"],
    {
      input: [
        "set -euo pipefail",
        "source deploy/lxc/release.sh",
        'sandbox="${PWD}/.tmp-srn-absent-unit-$$"',
        'mkdir "${sandbox}"',
        'trap \'rm -rf -- "${sandbox}"\' EXIT',
        'calls="${sandbox}/calls"',
        "service_active=true",
        'systemctl() {',
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
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("LXC contract rejects moving refs and masked source failures", () => {
  assert.match(
    validate(
      mutate("installer", 'REPO_REF="${REPO_REF:-}"', 'REPO_REF="${REPO_REF:-main}"'),
    ).join("\n"),
    /moving main branch/,
  );
  assert.match(
    validate(
      mutate(
        "installer",
        "git -C \"${SOURCE_DIR}\" fetch --all --tags --prune",
        "git -C \"${SOURCE_DIR}\" fetch --all --tags --prune || true",
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
    ["release", "git -C \"${source}\" archive", "isolated release stage"],
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
