// Behavioural tests for server/docker/internal-grpc-lane-env.sh — the helper
// that makes the socket SYNC_ITEMS lane self-configuring.
//
// These RUN the shell rather than grepping it. The two things it decides
// (whether to mint the durable-command secret, and whether to take gRPC) are
// both "do nothing" on every failure path, so a static check that the code is
// present would pass just as happily against a helper that always declines.
//
// Each case copies the helper into a sandbox and drives it entirely through
// relative-to-$PWD paths, so nothing here has to translate a Windows path into
// the shell's view of it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = join(root, "server/docker/internal-grpc-lane-env.sh");

const COLOCATED_SUPERVISORD = [
  "[supervisord]",
  "nodaemon=true",
  "",
  "[program:syncing-server]",
  "command=/opt/server/packages/syncing-server/supervisor/supervisor-server.sh",
  "",
  "[program:auth]",
  "command=/opt/server/packages/auth/supervisor/supervisor-server.sh",
  "",
  "[program:api-gateway]",
  "command=/opt/server/packages/api-gateway/supervisor/supervisor-server.sh",
  "",
].join("\n");

// One half only: what a per-service split of this image would look like.
const GATEWAY_ONLY_SUPERVISORD = [
  "[supervisord]",
  "nodaemon=true",
  "",
  "[program:api-gateway]",
  "command=/opt/server/packages/api-gateway/supervisor/supervisor-server.sh",
  "",
].join("\n");

// `nc -z <host> <port>`: succeeds unless the port is the one the case declares
// closed, and records every probe so a test can assert WHICH address was tried.
const FAKE_NC = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "${FAKE_NC_LOG}"',
  'for argument in "$@"; do',
  '  if [ -n "${FAKE_NC_CLOSED_PORT:-}" ] && [ "${argument}" = "${FAKE_NC_CLOSED_PORT}" ]; then',
  "    exit 1",
  "  fi",
  "done",
  "exit 0",
  "",
].join("\n");

function sandbox({ supervisord = COLOCATED_SUPERVISORD } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "srn-grpc-lane-"));
  copyFileSync(helperSource, join(directory, "internal-grpc-lane-env.sh"));
  writeFileSync(join(directory, "supervisord.conf"), supervisord);
  mkdirSync(join(directory, "bin"));
  const fakeNc = join(directory, "bin", "nc");
  writeFileSync(fakeNc, FAKE_NC);
  chmodSync(fakeNc, 0o755);
  writeFileSync(join(directory, "nc.log"), "");
  return directory;
}

function run(directory, { body, env = {}, shellOptions = "set -u" }) {
  const script = [
    shellOptions,
    'PATH="$PWD/bin:$PATH"',
    "export PATH",
    'export FAKE_NC_LOG="$PWD/nc.log"',
    'export SRN_SUPERVISORD_CONF="$PWD/supervisord.conf"',
    'export SRN_INTERNAL_GRPC_SECRET_FILE="$PWD/data/internal-grpc-auth-secret"',
    ". ./internal-grpc-lane-env.sh",
    body,
  ].join("\n");

  const result = spawnSync("bash", ["-s"], {
    input: script,
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(
    result.error,
    undefined,
    `bash could not be started: ${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `helper exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const parsed = {};
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      parsed[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }

  // Asserted HERE rather than case by case, so every branch of both functions
  // proves it and a new case cannot forget to. The two outcome tokens were
  // assigned and never exported: readable in the shell that sourced the helper,
  // invisible to every child of it — which is every supervisord program, and so
  // the api-gateway whose `process.env` the admin panel reports from.
  for (const [token, exported] of [
    ["DECISION", "SRN_SERVICE_PROXY_TYPE_DECISION_EXPORTED"],
    ["STATE", "SRN_INTERNAL_GRPC_SECRET_STATE_EXPORTED"],
  ]) {
    if (parsed[token] === undefined) {
      continue;
    }
    assert.equal(
      parsed[exported],
      `EXPORTED:${parsed[token]}`,
      `${exported.replace("_EXPORTED", "")} must be exported, not merely assigned: a child process read ${JSON.stringify(parsed[exported] ?? "")} while the sourcing shell read ${JSON.stringify(parsed[token])}`,
    );
  }

  return parsed;
}

// `env` is an external command, so it is a CHILD process and lists only
// EXPORTED variables. Reading the outcome tokens back through it is the
// difference the two state variables got wrong for their whole life: both were
// assigned and never exported, which looks identical from inside the shell that
// sourced the helper — the entrypoint's own boot log read them correctly — and
// means supervisord's programs, and so the gateway's `process.env`, never saw
// them at all. `EXPORTED:` is prefixed so "exported and empty" cannot be
// mistaken for "not exported".
const exportedLine = (name) =>
  `printf "${name}_EXPORTED=%s\\n" "$(env | sed -n 's/^${name}=/EXPORTED:/p')"`;

const SECRET_BODY = [
  "srn_prepare_internal_grpc_secret",
  'printf "STATE=%s\\n" "$SRN_INTERNAL_GRPC_SECRET_STATE"',
  exportedLine("SRN_INTERNAL_GRPC_SECRET_STATE"),
  'printf "SYNC=%s\\n" "${SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET:-}"',
  'printf "GATEWAY=%s\\n" "${API_GATEWAY_SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET:-}"',
  'if [ -r "$SRN_INTERNAL_GRPC_SECRET_FILE" ]; then',
  '  printf "FILE=%s\\n" "$(tr -d "\\r\\n" < "$SRN_INTERNAL_GRPC_SECRET_FILE")"',
  "else",
  '  printf "FILE=\\n"',
  "fi",
].join("\n");

// The wrapper runs under `set -euo pipefail`; so does every proxy case, because
// an unguarded failing command inside the helper would kill the gateway launcher
// rather than fall back to HTTP.
const PROXY_BODY = [
  "srn_resolve_service_proxy_type",
  'printf "DECISION=%s\\n" "$SRN_SERVICE_PROXY_TYPE_DECISION"',
  exportedLine("SRN_SERVICE_PROXY_TYPE_DECISION"),
  'printf "PROXY=%s\\n" "${SERVICE_PROXY_TYPE:-}"',
  'printf "PROBES=%s\\n" "$(tr "\\n" ";" < "$PWD/nc.log")"',
].join("\n");

function proxyEnvironment(overrides = {}) {
  return {
    SERVICE_PROXY_TYPE: "",
    API_GATEWAY_SERVICE_PROXY_TYPE: "",
    API_GATEWAY_AUTH_SERVER_GRPC_URL: "0.0.0.0:50051",
    API_GATEWAY_SYNCING_SERVER_GRPC_URL: "0.0.0.0:50052",
    SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "a".repeat(64),
    SRN_GRPC_PROBE_ATTEMPTS: "2",
    SRN_GRPC_PROBE_INTERVAL_SECONDS: "0",
    ...overrides,
  };
}

test("a supplied durable-command secret is never overwritten and never copied to disk", () => {
  const supplied = `operator-${"z".repeat(32)}`;
  const directory = sandbox();
  const parsed = run(directory, {
    body: SECRET_BODY,
    env: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: supplied },
  });

  assert.equal(parsed.STATE, "supplied");
  assert.equal(parsed.SYNC, supplied);
  assert.equal(parsed.GATEWAY, supplied);
  // The operator's .env is the value's home. A second copy on the volume is a
  // second place to leak it from and a second place for it to go stale.
  assert.equal(parsed.FILE, "");
});

test("a 32-byte secret is kept and a 31-byte one is replaced", () => {
  const kept = run(sandbox(), {
    body: SECRET_BODY,
    env: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "a".repeat(32) },
  });
  assert.equal(kept.STATE, "supplied");
  assert.equal(kept.SYNC, "a".repeat(32));

  const replaced = run(sandbox(), {
    body: SECRET_BODY,
    env: { SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "a".repeat(31) },
  });
  assert.equal(replaced.STATE, "minted-persisted");
  assert.match(replaced.SYNC, /^[0-9a-f]{64}$/);
  assert.notEqual(replaced.SYNC, "a".repeat(31));
});

test("the short-secret threshold counts bytes, not characters", () => {
  // Sixteen U+00E9, which is 16 characters and exactly 32 UTF-8 bytes.
  // `${#value}` would read 16 and discard a secret InternalGrpcServiceAuth
  // accepts, silently rotating a working operator key.
  const directory = sandbox();
  const parsed = run(directory, {
    body: [
      "multibyte=''",
      "index=0",
      "while [ $index -lt 16 ]; do",
      '  multibyte="${multibyte}$(printf "\\303\\251")"',
      "  index=$((index + 1))",
      "done",
      'export SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$multibyte"',
      'printf "CHARACTERS=%s\\n" "${#multibyte}"',
      SECRET_BODY,
    ].join("\n"),
  });

  assert.equal(parsed.CHARACTERS, "16");
  assert.equal(parsed.STATE, "supplied");
  assert.equal(parsed.FILE, "");
});

test("an absent secret is minted, persisted, and exported under both names as one value", () => {
  const directory = sandbox();
  const parsed = run(directory, { body: SECRET_BODY });

  assert.equal(parsed.STATE, "minted-persisted");
  assert.match(parsed.SYNC, /^[0-9a-f]{64}$/);
  // The signer reads API_GATEWAY_* and the verifier reads the bare name. One
  // value under two names is the whole point: the halves must agree byte for
  // byte or the lane is advertised and then every command fails verification.
  assert.equal(parsed.GATEWAY, parsed.SYNC);
  assert.equal(parsed.FILE, parsed.SYNC);
  assert.equal(
    readFileSync(join(directory, "data/internal-grpc-auth-secret"), "utf8"),
    `${parsed.SYNC}\n`,
  );
});

test("a restart reuses the persisted value instead of minting a new one", () => {
  const directory = sandbox();
  const first = run(directory, { body: SECRET_BODY });
  const second = run(directory, { body: SECRET_BODY });

  assert.equal(first.STATE, "minted-persisted");
  assert.equal(second.STATE, "persisted");
  // supervisord can restart either half alone. A per-boot value would hand a
  // restarted api-gateway a key the still-running syncing-server does not have.
  assert.equal(second.SYNC, first.SYNC);
  assert.equal(second.GATEWAY, first.SYNC);
});

test("minting is refused when the two halves are not co-located", () => {
  const directory = sandbox({ supervisord: GATEWAY_ONLY_SUPERVISORD });
  const parsed = run(directory, { body: SECRET_BODY });

  assert.equal(parsed.STATE, "not-colocated");
  assert.equal(parsed.SYNC, "");
  assert.equal(parsed.GATEWAY, "");
  assert.equal(parsed.FILE, "");
});

test("an unwritable persistent store degrades to an ephemeral value, loudly", () => {
  const directory = sandbox();
  // A plain file where the secret's directory should be: mkdir -p fails.
  writeFileSync(join(directory, "data"), "not a directory\n");
  const parsed = run(directory, { body: SECRET_BODY });

  assert.equal(parsed.STATE, "minted-ephemeral");
  assert.match(parsed.SYNC, /^[0-9a-f]{64}$/);
  assert.equal(parsed.GATEWAY, parsed.SYNC);
});

test("an explicit http proxy type survives the default", () => {
  const parsed = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ API_GATEWAY_SERVICE_PROXY_TYPE: "http" }),
  });

  assert.equal(parsed.DECISION, "operator");
  assert.equal(parsed.PROXY, "http");
  // An operator who said http is not probed: the answer cannot change anything.
  assert.equal(parsed.PROBES, "");
});

test("an explicit grpc proxy type survives and is not re-derived", () => {
  const parsed = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({
      API_GATEWAY_SERVICE_PROXY_TYPE: "grpc",
      SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "",
    }),
  });

  assert.equal(parsed.DECISION, "operator");
  assert.equal(parsed.PROXY, "grpc");
  assert.equal(parsed.PROBES, "");
});

test("gRPC is taken by default only when both listeners answer", () => {
  const parsed = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment(),
  });

  assert.equal(parsed.DECISION, "grpc-default");
  assert.equal(parsed.PROXY, "grpc");
  // The entrypoint writes the targets as the 0.0.0.0 BIND address; the probe has
  // to ask the loopback address the gateway will really reach.
  assert.equal(parsed.PROBES, "-z 127.0.0.1 50051;-z 127.0.0.1 50052;");
});

test("an explicit auto is treated as unset and never reaches the gateway literally", () => {
  const parsed = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ API_GATEWAY_SERVICE_PROXY_TYPE: "AUTO" }),
  });

  assert.equal(parsed.DECISION, "grpc-default");
  assert.equal(parsed.PROXY, "grpc");
});

test("an unreachable gRPC listener keeps the HTTP proxies instead of breaking the API", () => {
  // GRPCServiceProxy has no HTTP fallback: validateSession retries UNAVAILABLE
  // three times and then throws, on every authenticated request. Defaulting to
  // grpc against a dead listener is an outage, not a degradation.
  const auth = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ FAKE_NC_CLOSED_PORT: "50051" }),
  });
  assert.equal(auth.DECISION, "auth-grpc-unreachable");
  assert.equal(auth.PROXY, "");

  const syncing = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ FAKE_NC_CLOSED_PORT: "50052" }),
  });
  assert.equal(syncing.DECISION, "syncing-grpc-unreachable");
  assert.equal(syncing.PROXY, "");
  // Bounded: two attempts per endpoint, then an answer. An unbounded wait here
  // would hang the gateway launcher forever on a misconfigured port.
  assert.equal(
    syncing.PROBES,
    "-z 127.0.0.1 50051;-z 127.0.0.1 50052;-z 127.0.0.1 50052;",
  );
});

test("gRPC is declined when the durable-command secret or a dial target is missing", () => {
  const noSecret = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "" }),
  });
  assert.equal(noSecret.DECISION, "no-secret");
  assert.equal(noSecret.PROXY, "");

  const shortSecret = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({
      SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "a".repeat(31),
    }),
  });
  assert.equal(shortSecret.DECISION, "no-secret");

  const noUrl = run(sandbox(), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ API_GATEWAY_SYNCING_SERVER_GRPC_URL: "" }),
  });
  assert.equal(noUrl.DECISION, "no-grpc-urls");
  assert.equal(noUrl.PROXY, "");

  const notColocated = run(sandbox({ supervisord: GATEWAY_ONLY_SUPERVISORD }), {
    body: PROXY_BODY,
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment(),
  });
  assert.equal(notColocated.DECISION, "not-colocated");
  assert.equal(notColocated.PROXY, "");
});

// The consumer that matters is a NODE process: `supervisor-server.sh` ends in
// `exec yarn node docker/entrypoint-server.js`, and `DeploymentDiagnostics`
// reads both tokens out of `process.env` to fill the admin panel's "why is this
// deployment on HTTP" and "durable-command secret" rows. `env`-based checks
// prove the export attribute; this proves the thing the export is FOR.
test("both outcome tokens reach a node process's process.env", () => {
  const directory = sandbox();
  const parsed = run(directory, {
    body: [
      "srn_prepare_internal_grpc_secret",
      "srn_resolve_service_proxy_type",
      `printf "NODE_STATE=%s\\n" "$(node -e 'process.stdout.write(process.env.SRN_INTERNAL_GRPC_SECRET_STATE || "ABSENT")')"`,
      `printf "NODE_DECISION=%s\\n" "$(node -e 'process.stdout.write(process.env.SRN_SERVICE_PROXY_TYPE_DECISION || "ABSENT")')"`,
    ].join("\n"),
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: "" }),
  });

  // The secret is minted here, so the proxy resolver finds a usable one.
  assert.equal(parsed.NODE_STATE, "minted-persisted");
  assert.equal(parsed.NODE_DECISION, "grpc-default");
  // ABSENT is what the variable looked like for this module's whole life: the
  // launcher logged a decision and the process it exec'd had no such variable.
  assert.notEqual(parsed.NODE_STATE, "ABSENT");
  assert.notEqual(parsed.NODE_DECISION, "ABSENT");
});

test("a declining branch exports its reason too, so HTTP can be explained", () => {
  // The reason matters most when gRPC was NOT taken: `not-colocated` means HTTP
  // is correct here, `syncing-grpc-unreachable` means something is broken. Both
  // had to cross the process boundary for the panel to tell them apart.
  const unreachable = run(sandbox(), {
    body: [
      "srn_resolve_service_proxy_type",
      `printf "NODE_DECISION=%s\\n" "$(node -e 'process.stdout.write(process.env.SRN_SERVICE_PROXY_TYPE_DECISION || "ABSENT")')"`,
      'printf "PROXY=%s\\n" "${SERVICE_PROXY_TYPE:-}"',
    ].join("\n"),
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment({ FAKE_NC_CLOSED_PORT: "50052" }),
  });
  assert.equal(unreachable.NODE_DECISION, "syncing-grpc-unreachable");
  assert.equal(unreachable.PROXY, "");

  const split = run(sandbox({ supervisord: GATEWAY_ONLY_SUPERVISORD }), {
    body: [
      "srn_resolve_service_proxy_type",
      `printf "NODE_DECISION=%s\\n" "$(node -e 'process.stdout.write(process.env.SRN_SERVICE_PROXY_TYPE_DECISION || "ABSENT")')"`,
    ].join("\n"),
    shellOptions: "set -euo pipefail",
    env: proxyEnvironment(),
  });
  assert.equal(split.NODE_DECISION, "not-colocated");
});

// The helper is only worth anything if something calls it. Each of these three
// wirings is a place the lane has silently died before: a value that reached
// only one half, and a switch nothing set.
test("the helper is wired into the image, the entrypoint and the gateway launcher", () => {
  const dockerfile = readFileSync(join(root, "server/Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /COPY docker\/internal-grpc-lane-env\.sh \/usr\/local\/bin\/internal-grpc-lane-env\.sh/,
  );
  assert.ok(
    dockerfile.includes(
      "chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/deployment-identity-env.sh /usr/local/bin/internal-grpc-lane-env.sh",
    ),
    "the helper must be executable in the image",
  );

  const entrypoint = readFileSync(
    join(root, "server/docker/docker-entrypoint.sh"),
    "utf8",
  );
  const sourced = entrypoint.indexOf(
    ". /usr/local/bin/internal-grpc-lane-env.sh",
  );
  const prepared = entrypoint.indexOf("srn_prepare_internal_grpc_secret");
  // Located by the DESTINATION path, not by the whole pipeline. These two lines
  // were matched verbatim and the projections were later rewritten from
  // `printenv | grep X_ | sed 's/X_//g'` to the anchored
  // `printenv | sed -n 's/^X_//p'`; both `indexOf` calls then returned -1, the
  // ordering assertion read `prepared < -1`, and this gate sat red while
  // asserting nothing about the thing it names. Finding each line is asserted
  // separately so a renamed destination fails loudly instead of silently.
  const projectionOf = (destination) => {
    const line = entrypoint
      .split("\n")
      .find(
        (candidate) =>
          candidate.includes(`> ${destination}`) &&
          candidate.startsWith("printenv"),
      );
    assert.ok(
      line !== undefined,
      `no printenv projection writes ${destination}`,
    );
    return entrypoint.indexOf(line);
  };
  const syncingProjection = projectionOf(
    "/opt/server/packages/syncing-server/.env",
  );
  const gatewayProjection = projectionOf(
    "/opt/server/packages/api-gateway/.env",
  );
  assert.ok(sourced >= 0 && prepared > sourced);
  // Both dotenvs are written from the resolved value, or one half gets nothing.
  assert.ok(
    prepared < syncingProjection && prepared < gatewayProjection,
    "the secret must be resolved before either dotenv projection",
  );
  // The entrypoint must not force the proxy type: it cannot probe anything yet,
  // and validate-docker-hardening.mjs enforces this too.
  assert.doesNotMatch(
    entrypoint,
    /^[ \t]*export\s+API_GATEWAY_SERVICE_PROXY_TYPE=/m,
  );

  const launcher = readFileSync(
    join(root, "server/packages/api-gateway/supervisor/supervisor-server.sh"),
    "utf8",
  );
  const waited = launcher.indexOf(
    "sh supervisor/wait-for.sh localhost $SYNCING_SERVER_PORT",
  );
  const resolved = launcher.indexOf("srn_resolve_service_proxy_type");
  const execed = launcher.indexOf("exec yarn node");
  assert.ok(waited >= 0 && resolved > waited && execed > resolved);
});
