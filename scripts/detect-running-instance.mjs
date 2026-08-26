#!/usr/bin/env node

/**
 * Launch preflight: is the port free, and if not, WHOSE is it?
 *
 * "Is the port free?" is the easy half and the less useful one. The dangerous
 * case is a port that IS occupied by THIS app — a stale instance from an earlier
 * run, or a different build — because then everything appears to work while you
 * are testing the wrong code. Hours get spent diagnosing symptoms that the build
 * on disk already fixed.
 *
 * So this script answers three questions in one pass:
 *   1. is anything listening on the port at all,
 *   2. is what is listening OURS, and
 *   3. WHICH BUILD is it.
 *
 * (2) and (3) come from the public deployment marker at
 * /.well-known/srn-deployment.json — the same marker an incident responder uses
 * to ask "which commit is live?". It returns a real 40-hex commit revision, the
 * explicit `unstamped` sentinel when a build recorded none, or empty strings if
 * the running thing predates the marker work entirely. /healthcheck is the
 * fallback identity signal for a build too old to carry a marker.
 *
 * Deliberately NOT automated: nothing here kills, restarts, or otherwise touches
 * a process it finds. A stale instance may be a deliberate session belonging to
 * someone else. Detect, report, let the human decide.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export const DEPLOYMENT_MARKER_PATH = "/.well-known/srn-deployment.json";
export const HEALTHCHECK_PATH = "/healthcheck";
export const UNSTAMPED_SENTINEL = "unstamped";

const revisionPattern = /^[0-9a-f]{40}$/;
const maximumMarkerBytes = 4096;
const defaultProbeTimeoutMs = 1500;
const defaultAdjustAttempts = 20;

/**
 * The ports a local launch actually binds. `adjustable` encodes whether moving
 * this service to another port is even coherent: a webpack dev server can live
 * anywhere (you follow the URL it prints), but the desktop extensions server is
 * pinned at 45653 by the value persisted into the desktop store, so "just use
 * the next port" would silently serve components from the wrong place.
 */
export const DEFAULT_TARGETS = {
  "web-dev": {
    port: 3001,
    host: "127.0.0.1",
    adjustable: true,
    description: "webpack dev server (yarn start:web)",
  },
  app: {
    port: 3001,
    host: "127.0.0.1",
    adjustable: false,
    description: "app front door / nginx (docker compose, APP_PORT)",
  },
  gateway: {
    port: 3000,
    host: "127.0.0.1",
    adjustable: false,
    description: "api-gateway HTTP port",
  },
  "ext-server": {
    port: 45653,
    host: "127.0.0.1",
    adjustable: false,
    description: "desktop extensions/components server",
  },
};

export const TARGET_GROUPS = {
  web: ["web-dev"],
  docker: ["app", "gateway"],
  desktop: ["ext-server"],
  all: ["web-dev", "app", "gateway", "ext-server"],
};

// ---------------------------------------------------------------------------
// Port availability
// ---------------------------------------------------------------------------

/**
 * Can we bind it? `exclusive: true` matters: without it a POSIX bind can share
 * a wildcard-bound socket and report "free" for a port that plainly is not.
 * Windows binds exclusively by default, so this keeps both platforms answering
 * the same question.
 */
export function probePortBinding({ host = "127.0.0.1", port }) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const settle = (result) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // Closing a server that never listened is not an error worth surfacing.
      }
      resolve(result);
    };
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        settle({ bindable: false, code: "EADDRINUSE" });
        return;
      }
      // EACCES on Windows is the "excluded port range" / reserved-by-Hyper-V
      // case, which is just as much a launch blocker as an occupied port.
      settle({ bindable: false, code: error.code ?? "EUNKNOWN" });
    });
    server.once("listening", () => settle({ bindable: true, code: null }));
    try {
      server.listen({ host, port, exclusive: true });
    } catch (error) {
      settle({ bindable: false, code: error?.code ?? "EUNKNOWN" });
    }
  });
}

/**
 * Can we reach it? A bind probe against 127.0.0.1 says nothing about a server
 * bound only to another interface (a published container port, for instance),
 * so reachability is probed separately and the two are reported together.
 */
export function probeConnect({
  host = "127.0.0.1",
  port,
  timeoutMs = defaultProbeTimeoutMs,
}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const settle = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function parseDeploymentMarker(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (
    typeof parsed.revision !== "string" ||
    typeof parsed.version !== "string"
  ) {
    return null;
  }
  return { revision: parsed.revision, version: parsed.version };
}

async function readBounded(response) {
  const text = await response.text();
  return text.length > maximumMarkerBytes
    ? text.slice(0, maximumMarkerBytes)
    : text;
}

/**
 * Ask the listener who it is. Never throws: an occupant that hangs up, speaks
 * TLS, or is not HTTP at all is a legitimate answer ("not ours"), not a crash.
 */
export async function probeInstanceIdentity({
  host = "127.0.0.1",
  port,
  timeoutMs = defaultProbeTimeoutMs,
  fetchImpl = fetch,
}) {
  const origin = `http://${host}:${port}`;
  const request = async (pathname) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}${pathname}`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      return { status: response.status, body: await readBounded(response) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const markerResponse = await request(DEPLOYMENT_MARKER_PATH);
  const healthResponse = await request(HEALTHCHECK_PATH);

  return {
    markerStatus: markerResponse?.status ?? null,
    marker:
      markerResponse && markerResponse.status === 200
        ? parseDeploymentMarker(markerResponse.body)
        : null,
    healthcheckStatus: healthResponse?.status ?? null,
    spokeHttp: markerResponse !== null || healthResponse !== null,
  };
}

/**
 * Pure classifier — the whole decision surface lives here so it can be tested
 * without a socket. Severity ordering: `critical` means "you are about to be
 * lied to by a stale instance"; `warning` means our app is there and you at
 * least know which build; `notice` means an unrelated occupant.
 */
export function classifyOccupant({ reachable, identity, expectedRevision }) {
  if (!reachable) {
    return {
      kind: "free",
      severity: "ok",
      ours: false,
      revision: null,
      version: null,
      summary: "nothing is listening",
    };
  }

  const marker = identity?.marker ?? null;

  if (!marker) {
    // A live /healthcheck with no marker is one of ours from before the marker
    // landed. That is the worst case for identity: definitely ours, and there
    // is no way at all to learn which commit it is running.
    if (identity?.healthcheckStatus === 200) {
      return {
        kind: "ours-legacy",
        severity: "critical",
        ours: true,
        revision: null,
        version: null,
        summary:
          "our app is here but serves no deployment marker — it predates the marker, so its build CANNOT be identified",
      };
    }
    return {
      kind: "foreign",
      severity: "notice",
      ours: false,
      revision: null,
      version: null,
      summary: identity?.spokeHttp
        ? "an unrelated HTTP server is here"
        : "something is listening but it is not our app",
    };
  }

  const revision = marker.revision === "" ? null : marker.revision;
  const version = marker.version === "" ? null : marker.version;

  if (revision === null || !revisionPattern.test(revision)) {
    return {
      kind: "ours-unidentified",
      severity: "critical",
      ours: true,
      revision: null,
      version,
      summary:
        version === UNSTAMPED_SENTINEL
          ? "our app is here but the build recorded no revision (unstamped) — its commit is unknowable"
          : "our app is here but its deployment marker carries no usable revision — its commit is unknowable",
    };
  }

  if (!expectedRevision) {
    return {
      kind: "ours-known-build",
      severity: "warning",
      ours: true,
      revision,
      version,
      summary: `our app is here running ${revision.slice(0, 7)} (no expected revision to compare against)`,
    };
  }

  if (revision === expectedRevision) {
    return {
      kind: "ours-matching",
      severity: "warning",
      ours: true,
      revision,
      version,
      summary: `our app is already here running ${revision.slice(0, 7)}, the same commit you are launching`,
    };
  }

  return {
    kind: "ours-different-build",
    severity: "critical",
    ours: true,
    revision,
    version,
    summary: `our app is here running ${revision.slice(0, 7)} but you are launching ${expectedRevision.slice(0, 7)} — a DIFFERENT build`,
  };
}

/**
 * Collision policy.
 *
 * Moving to another port is only safe when the occupant has nothing to do with
 * us. When it IS one of ours, silently relocating is as harmful as attaching to
 * the stale instance: the browser tab, the bookmark, and the muscle memory all
 * still point at the old port, so the user keeps looking at the old build while
 * believing they restarted. Our app on the port is therefore always a stop —
 * the human picks between using the running instance, stopping it, or passing
 * an explicit port.
 */
export function decideCollisionAction({ classification, adjustable }) {
  if (classification.kind === "free") {
    return { action: "proceed", reason: "port is free" };
  }
  if (classification.ours) {
    return {
      action: "stop",
      reason:
        "our app already holds this port; moving to another port would leave you pointed at the old instance",
    };
  }
  if (adjustable) {
    return {
      action: "adjust",
      reason: "the occupant is unrelated to this app, so a different port is safe",
    };
  }
  return {
    action: "stop",
    reason: "an unrelated process holds a port this service cannot be moved off",
  };
}

// ---------------------------------------------------------------------------
// Who owns the socket (best effort, never fatal)
// ---------------------------------------------------------------------------

/** Parse `netstat -ano -p tcp` (Windows) for LISTENING pids on a port. */
export function parseNetstatListeners(stdout, port) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
    if (!/^LISTENING$/i.test(fields[3])) continue;
    const localPort = fields[1].slice(fields[1].lastIndexOf(":") + 1);
    if (localPort !== String(port)) continue;
    const pid = Number.parseInt(fields[4], 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Parse `tasklist /FO CSV /NH` rows into {pid, name}. */
export function parseTasklistCsv(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const name = fields[0].slice(1, -1);
    const pid = Number.parseInt(fields[1].slice(1, -1), 10);
    if (Number.isInteger(pid) && pid > 0) rows.push({ pid, name });
  }
  return rows;
}

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` (POSIX) into {pid, name}. */
export function parseLsofListeners(stdout) {
  const rows = [];
  const seen = new Set();
  for (const line of String(stdout).split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[1], 10);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    rows.push({ pid, name: fields[0] });
  }
  return rows;
}

function runQuietly(file, args, timeoutMs = 8000) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Name the process holding the port. Purely informational: a collision report
 * that says "node.exe pid 21840" is far more actionable than "port in use", but
 * failing to resolve it must never block a launch.
 */
export function describeListeners({ port, platform = process.platform }) {
  if (platform === "win32") {
    const netstat = runQuietly("netstat", ["-ano", "-p", "tcp"]);
    if (!netstat) return [];
    const pids = parseNetstatListeners(netstat, port);
    if (pids.length === 0) return [];
    const tasklist = runQuietly("tasklist", ["/FO", "CSV", "/NH"]);
    const byPid = new Map(
      (tasklist ? parseTasklistCsv(tasklist) : []).map((row) => [
        row.pid,
        row.name,
      ]),
    );
    return pids.map((pid) => ({ pid, name: byPid.get(pid) ?? "unknown" }));
  }
  const lsof = runQuietly("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
  ]);
  return lsof ? parseLsofListeners(lsof) : [];
}

// ---------------------------------------------------------------------------
// Desktop instance detection
// ---------------------------------------------------------------------------

const desktopProcessPattern =
  /^(electron|standard-red-notes|standard red notes|standardnotes)(\.exe)?$/i;

export function selectDesktopProcesses(rows) {
  return rows.filter((row) => desktopProcessPattern.test(row.name));
}

/**
 * The desktop app's authoritative guard is Electron's single-instance lock,
 * which is only observable from inside the app. From the outside the honest
 * signals are (a) a live process that looks like ours and (b) the extensions
 * server port. Both are reported; neither is acted on.
 */
export function detectDesktopInstances({ platform = process.platform } = {}) {
  if (platform === "win32") {
    const tasklist = runQuietly("tasklist", ["/FO", "CSV", "/NH"]);
    return tasklist ? selectDesktopProcesses(parseTasklistCsv(tasklist)) : [];
  }
  const ps = runQuietly("ps", ["-eo", "pid=,comm="]);
  if (!ps) return [];
  const rows = [];
  for (const line of String(ps).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number.parseInt(match[1], 10), name: path.basename(match[2]) });
  }
  return selectDesktopProcesses(rows);
}

// ---------------------------------------------------------------------------
// Inspection pipeline
// ---------------------------------------------------------------------------

export async function inspectPort({
  host = "127.0.0.1",
  port,
  expectedRevision = null,
  timeoutMs = defaultProbeTimeoutMs,
  fetchImpl = fetch,
  identifyProcess = true,
}) {
  const binding = await probePortBinding({ host, port });
  const reachable = binding.bindable
    ? await probeConnect({ host, port, timeoutMs })
    : true;

  const identity = reachable
    ? await probeInstanceIdentity({ host, port, timeoutMs, fetchImpl })
    : null;

  const classification = classifyOccupant({
    reachable,
    identity,
    expectedRevision,
  });

  return {
    host,
    port,
    bindable: binding.bindable,
    bindCode: binding.code,
    reachable,
    identity,
    classification,
    listeners:
      reachable && identifyProcess ? describeListeners({ port }) : [],
  };
}

/**
 * Resolve the port to actually launch on. Scans upward ONLY past unrelated
 * occupants; the first port held by our app stops the scan, because at that
 * point the user needs to know rather than be routed around it.
 */
export async function resolveLaunchPort({
  host = "127.0.0.1",
  port,
  expectedRevision = null,
  adjustable = false,
  attempts = defaultAdjustAttempts,
  timeoutMs = defaultProbeTimeoutMs,
  fetchImpl = fetch,
  identifyProcess = true,
}) {
  const inspections = [];
  for (let offset = 0; offset < Math.max(1, attempts); offset += 1) {
    const candidate = port + offset;
    const inspection = await inspectPort({
      host,
      port: candidate,
      expectedRevision,
      timeoutMs,
      fetchImpl,
      identifyProcess,
    });
    inspections.push(inspection);
    const decision = decideCollisionAction({
      classification: inspection.classification,
      adjustable,
    });
    if (decision.action === "proceed") {
      return {
        port: candidate,
        adjusted: candidate !== port,
        decision,
        inspections,
      };
    }
    if (decision.action === "stop") {
      return { port: null, adjusted: false, decision, inspections };
    }
  }
  return {
    port: null,
    adjusted: false,
    decision: {
      action: "stop",
      reason: `no free port found in ${attempts} attempts from ${port}`,
    },
    inspections,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const severityLabel = {
  ok: "ok  ",
  notice: "note",
  warning: "WARN",
  critical: "STOP",
};

export function formatInspection(inspection, { expectedRevision } = {}) {
  const { classification: c } = inspection;
  const lines = [
    `[${severityLabel[c.severity] ?? "????"}] ${inspection.host}:${inspection.port} — ${c.summary}`,
  ];
  if (c.ours) {
    lines.push(
      `         running:   revision ${c.revision ?? "<unknown>"}  version ${c.version ?? "<unknown>"}`,
    );
    lines.push(
      `         launching: revision ${expectedRevision ?? "<unknown>"}`,
    );
  }
  for (const listener of inspection.listeners) {
    lines.push(`         holder:    pid ${listener.pid} (${listener.name})`);
  }
  if (!inspection.bindable && inspection.bindCode !== "EADDRINUSE") {
    lines.push(
      `         bind failed with ${inspection.bindCode} (reserved or blocked port range)`,
    );
  }
  return lines.join("\n");
}

export function resolveExpectedRevision(repositoryRoot = defaultRepositoryRoot) {
  const revision = runQuietly(
    "git",
    ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    8000,
  )?.trim();
  return revision && revisionPattern.test(revision) ? revision : null;
}

/**
 * The identity a locally launched dev process should publish at the marker path.
 *
 * A dev server compiled straight from the working tree is not the commit alone —
 * uncommitted edits are exactly what you are usually testing. `dev-dirty` says
 * so, so a probe of a dev server never claims a clean commit it is not running.
 */
export function buildLocalDeploymentMarker({
  repositoryRoot = defaultRepositoryRoot,
  revision = resolveExpectedRevision(repositoryRoot),
} = {}) {
  if (!revision) {
    // Same fail-closed contract as the image build: unknowable is stated
    // outright rather than dressed up as a blank field.
    return { revision: "", version: UNSTAMPED_SENTINEL };
  }
  const status = runQuietly(
    "git",
    ["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=no"],
    8000,
  );
  const dirty = status === null || status.trim() !== "";
  return { revision, version: dirty ? "dev-dirty" : "dev" };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    targets: [],
    ports: [],
    host: null,
    expectedRevision: undefined,
    json: false,
    launchPlan: false,
    reportOnly: false,
    adjust: null,
    desktop: false,
    attempts: defaultAdjustAttempts,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--target":
        options.targets.push(requireValue());
        break;
      case "--port": {
        const port = Number.parseInt(requireValue(), 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("--port must be between 1 and 65535");
        }
        options.ports.push(port);
        break;
      }
      case "--host":
        options.host = requireValue();
        break;
      case "--expect-revision":
        options.expectedRevision = requireValue();
        break;
      case "--json":
        options.json = true;
        break;
      // Machine-readable result on stdout while the human report still goes to
      // stderr, so a launcher can consume the port AND the developer still sees
      // exactly what was found on the way there.
      case "--emit-launch-plan":
        options.launchPlan = true;
        break;
      case "--report-only":
        options.reportOnly = true;
        break;
      case "--adjust":
        options.adjust = true;
        break;
      case "--no-adjust":
        options.adjust = false;
        break;
      case "--desktop":
        options.desktop = true;
        break;
      case "--attempts":
        options.attempts = Number.parseInt(requireValue(), 10);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (options.targets.length === 0 && options.ports.length === 0) {
    options.targets.push("all");
  }
  return options;
}

/**
 * Minimal `.env` reader — enough for the handful of port keys docker compose
 * interpolates. scripts/setup.* writes APP_PORT there, so a customised install
 * must be checked on ITS port, not the default one, or the preflight cheerfully
 * clears a port nothing is going to bind.
 */
export function parseDotEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function applyEnvironmentOverrides(targets, env) {
  const port = Number.parseInt(env.APP_PORT ?? "", 10);
  const host = env.APP_BIND_ADDRESS;
  const overridden = { ...targets };
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    overridden.app = { ...overridden.app, port };
  }
  if (host && host !== "0.0.0.0") {
    overridden.app = { ...overridden.app, host };
  }
  return overridden;
}

function readRepositoryEnv(repositoryRoot = defaultRepositoryRoot) {
  try {
    return parseDotEnv(readFileSync(path.join(repositoryRoot, ".env"), "utf8"));
  } catch {
    return {};
  }
}

export function expandTargets(names) {
  const expanded = [];
  for (const name of names) {
    const group = TARGET_GROUPS[name];
    const members = group ?? [name];
    for (const member of members) {
      if (!DEFAULT_TARGETS[member]) {
        throw new Error(
          `unknown target: ${member} (known: ${Object.keys(DEFAULT_TARGETS).join(", ")}; groups: ${Object.keys(TARGET_GROUPS).join(", ")})`,
        );
      }
      if (!expanded.includes(member)) expanded.push(member);
    }
  }
  return expanded;
}

async function main(argv) {
  const options = parseArgs(argv);
  const expectedRevision =
    options.expectedRevision === undefined
      ? resolveExpectedRevision()
      : options.expectedRevision || null;

  const targets = applyEnvironmentOverrides(
    DEFAULT_TARGETS,
    readRepositoryEnv(),
  );
  const requested = expandTargets(options.targets).map((name) => ({
    name,
    ...targets[name],
  }));
  for (const port of options.ports) {
    requested.push({
      name: `port-${port}`,
      port,
      host: "127.0.0.1",
      adjustable: options.adjust === true,
      description: "explicit --port",
    });
  }

  const results = [];
  for (const target of requested) {
    const adjustable =
      options.adjust === null ? target.adjustable : options.adjust;
    const resolved = await resolveLaunchPort({
      host: options.host ?? target.host,
      port: target.port,
      expectedRevision,
      adjustable,
      attempts: adjustable ? options.attempts : 1,
    });
    results.push({ target, adjustable, resolved });
  }

  const desktopInstances = options.desktop ? detectDesktopInstances() : [];

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ expectedRevision, results, desktopInstances }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(
      `Launch preflight — launching revision ${expectedRevision ?? "<unknown>"}\n`,
    );
    for (const { target, resolved } of results) {
      process.stderr.write(`\n${target.name} (${target.description})\n`);
      for (const inspection of resolved.inspections) {
        process.stderr.write(
          `${formatInspection(inspection, { expectedRevision })}\n`,
        );
      }
      if (resolved.adjusted) {
        process.stderr.write(
          `         -> moving to port ${resolved.port} (${resolved.decision.reason})\n`,
        );
      } else if (resolved.decision.action === "stop") {
        process.stderr.write(`         -> ${resolved.decision.reason}\n`);
      }
    }
    if (options.desktop) {
      process.stderr.write("\ndesktop\n");
      if (desktopInstances.length === 0) {
        process.stderr.write("[ok  ] no running desktop instance detected\n");
      } else {
        for (const instance of desktopInstances) {
          process.stderr.write(
            `[WARN] desktop process already running: pid ${instance.pid} (${instance.name})\n`,
          );
        }
        process.stderr.write(
          "         Electron's single-instance lock means a second launch will exit and focus this one.\n",
        );
      }
    }
    process.stderr.write(
      "\nNothing was stopped or restarted — that call is yours.\n",
    );
  }

  const blocked = results.some(
    ({ resolved }) => resolved.decision.action === "stop",
  );

  if (options.launchPlan) {
    if (results.length !== 1) {
      throw new Error("--emit-launch-plan requires exactly one target or port");
    }
    process.stdout.write(
      `${JSON.stringify({
        port: results[0].resolved.port,
        adjusted: results[0].resolved.adjusted,
        blocked,
        marker: buildLocalDeploymentMarker({ revision: expectedRevision }),
      })}\n`,
    );
  }

  return options.reportOnly || !blocked ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    });
}
