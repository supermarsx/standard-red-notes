import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const allowlistPath = path.join(
  repositoryRoot,
  "scripts",
  "production-audit-allowlist.json",
);

export const enforcementSeverity = "critical";

export const auditDomains = Object.freeze([
  { id: "root", directory: ".", manager: "yarn", lockfile: "yarn.lock" },
  { id: "app", directory: "app", manager: "yarn", lockfile: "app/yarn.lock" },
  {
    id: "filepicker-example",
    directory: "app/packages/filepicker/example",
    manager: "yarn",
    lockfile: "app/packages/filepicker/example/yarn.lock",
  },
  {
    id: "server",
    directory: "server",
    manager: "yarn",
    lockfile: "server/yarn.lock",
  },
  {
    id: "cli-client",
    directory: "cli/srn-client",
    manager: "npm",
    lockfile: "cli/srn-client/package-lock.json",
  },
  {
    id: "cli-server",
    directory: "cli/srn-server",
    manager: "npm",
    lockfile: "cli/srn-server/package-lock.json",
  },
  {
    id: "release-policy",
    directory: "scripts",
    manager: "npm",
    lockfile: "scripts/package-lock.json",
  },
]);

const severityRank = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

function auditKey(advisory) {
  return `${advisory.domain}\0${advisory.advisoryId}\0${advisory.package}`;
}

function auditEvidenceValues(value) {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function isUtcCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function executable(name) {
  return process.platform === "win32" && ["corepack", "npm"].includes(name)
    ? `${name}.cmd`
    : name;
}

export function trackedLockfilesFromGitOutput(output) {
  return output
    .split("\0")
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) =>
      /(^|\/)(?:yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(file),
    )
    .sort();
}

export function validateLockfileInventory(
  trackedLockfiles,
  domains = auditDomains,
) {
  const configured = domains.map((domain) => domain.lockfile).sort();
  const tracked = [...new Set(trackedLockfiles)].sort();
  const missing = tracked.filter((lockfile) => !configured.includes(lockfile));
  const stale = configured.filter((lockfile) => !tracked.includes(lockfile));
  const errors = [];

  if (missing.length > 0) {
    errors.push(`uncovered committed lockfiles: ${missing.join(", ")}`);
  }
  if (stale.length > 0) {
    errors.push(`configured lockfiles are not committed: ${stale.join(", ")}`);
  }

  return errors;
}

export function parseYarnAudit(output, domain) {
  const advisories = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    let report;
    try {
      report = JSON.parse(line);
    } catch {
      throw new Error(`${domain}: Yarn audit returned non-JSON output`);
    }

    const advisory = report?.children;
    if (!advisory || !/^\d+$/u.test(String(advisory.ID ?? ""))) {
      continue;
    }

    advisories.push({
      domain,
      advisoryId: String(advisory.ID),
      package: String(report.value),
      severity: String(advisory.Severity).toLowerCase(),
      title: String(advisory.Issue ?? ""),
      url: String(advisory.URL ?? ""),
      vulnerableVersions: String(advisory["Vulnerable Versions"] ?? ""),
      versions: auditEvidenceValues(advisory["Tree Versions"]),
      dependents: auditEvidenceValues(advisory.Dependents),
    });
  }
  return advisories;
}

export function parseNpmAudit(output, domain) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error(`${domain}: npm audit returned non-JSON output`);
  }

  if (report?.error) {
    throw new Error(
      `${domain}: npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`,
    );
  }

  const advisories = [];
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (typeof via === "string" || via?.source === undefined) {
        continue;
      }
      advisories.push({
        domain,
        advisoryId: String(via.source),
        package: String(via.name),
        severity: String(via.severity).toLowerCase(),
        title: String(via.title ?? ""),
        url: String(via.url ?? ""),
      });
    }
  }
  return advisories;
}

export function enforceableAdvisories(advisories) {
  const minimum = severityRank[enforcementSeverity];
  const unique = new Map();
  for (const advisory of advisories) {
    const rank = severityRank[advisory.severity];
    if (rank === undefined) {
      throw new Error(
        `${advisory.domain}: unknown advisory severity ${advisory.severity}`,
      );
    }
    if (rank >= minimum) {
      const key = auditKey(advisory);
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, advisory);
        continue;
      }

      const merged = { ...existing };
      const vulnerableVersions = [
        existing.vulnerableVersions,
        advisory.vulnerableVersions,
      ].filter((value) => typeof value === "string" && value.length > 0);
      if (vulnerableVersions.length > 0) {
        merged.vulnerableVersions = [...new Set(vulnerableVersions)]
          .sort()
          .join(" || ");
      }
      for (const field of ["versions", "dependents"]) {
        const values = [
          ...auditEvidenceValues(existing[field]),
          ...auditEvidenceValues(advisory[field]),
        ];
        if (values.length > 0) {
          merged[field] = [...new Set(values)].sort();
        }
      }
      unique.set(key, merged);
    }
  }
  return [...unique.values()].sort((left, right) =>
    auditKey(left).localeCompare(auditKey(right)),
  );
}

export function validateAllowlist(advisories, allowlist, today) {
  const errors = [];
  const allowed = new Map();
  const requiredFields = [
    "advisoryId",
    "package",
    "domain",
    "vulnerableVersions",
    "versions",
    "dependents",
    "rationale",
    "expiry",
  ];
  const knownDomains = new Set(auditDomains.map((domain) => domain.id));

  if (!Array.isArray(allowlist)) {
    return ["production advisory allowlist must be an array"];
  }

  for (const [index, entry] of allowlist.entries()) {
    const label = `allowlist entry ${index + 1}`;
    const keys = Object.keys(entry ?? {}).sort();
    if (keys.join("\0") !== [...requiredFields].sort().join("\0")) {
      errors.push(
        `${label}: must contain exactly ${requiredFields.join(", ")}`,
      );
      continue;
    }
    if (!/^\d+$/u.test(entry.advisoryId)) {
      errors.push(
        `${label}: advisoryId must be a numeric registry advisory ID`,
      );
    }
    if (!knownDomains.has(entry.domain)) {
      errors.push(`${label}: unknown lock domain ${entry.domain}`);
    }
    if (typeof entry.package !== "string" || entry.package.length === 0) {
      errors.push(`${label}: package must be non-empty`);
    }
    if (
      typeof entry.vulnerableVersions !== "string" ||
      entry.vulnerableVersions.length === 0
    ) {
      errors.push(`${label}: vulnerableVersions must be non-empty`);
    }
    for (const field of ["versions", "dependents"]) {
      if (
        !Array.isArray(entry[field]) ||
        entry[field].length === 0 ||
        entry[field].some(
          (value) => typeof value !== "string" || value.length === 0,
        ) ||
        JSON.stringify(entry[field]) !==
          JSON.stringify([...new Set(entry[field])].sort())
      ) {
        errors.push(
          `${label}: ${field} must be a non-empty sorted array of unique strings`,
        );
      }
    }
    if (typeof entry.rationale !== "string" || entry.rationale.length < 40) {
      errors.push(
        `${label}: rationale must explain the compatibility exception`,
      );
    }
    if (!isUtcCalendarDate(entry.expiry)) {
      errors.push(`${label}: expiry must be a real UTC date using YYYY-MM-DD`);
    } else if (entry.expiry < today) {
      errors.push(`${label}: expired on ${entry.expiry}`);
    }

    const key = auditKey(entry);
    if (allowed.has(key)) {
      errors.push(`${label}: duplicate advisory exception`);
    }
    allowed.set(key, entry);
  }

  const observed = new Map(
    advisories.map((advisory) => [auditKey(advisory), advisory]),
  );
  for (const [key, advisory] of observed) {
    const exception = allowed.get(key);
    if (!exception) {
      errors.push(
        `${advisory.domain}: unallowlisted ${advisory.severity} advisory ${advisory.advisoryId} for ${advisory.package}`,
      );
      continue;
    }
    for (const field of ["vulnerableVersions", "versions", "dependents"]) {
      if (
        JSON.stringify(advisory[field]) !== JSON.stringify(exception[field])
      ) {
        errors.push(
          `${advisory.domain}: advisory ${advisory.advisoryId} exception evidence changed for ${field}`,
        );
      }
    }
  }
  for (const [key, entry] of allowed) {
    if (!observed.has(key)) {
      errors.push(
        `${entry.domain}: stale or unused exception ${entry.advisoryId} for ${entry.package}`,
      );
    }
  }

  return errors;
}

function yarnVersions(lockfile, packageName) {
  const versions = [];
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const header = new RegExp(`^"${escapedName}@npm:[^"]+":$`, "u");
  const lines = lockfile.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!header.test(lines[index])) {
      continue;
    }
    const version = /^  version: (\S+)$/u.exec(lines[index + 1] ?? "")?.[1];
    if (version) {
      versions.push(version.replaceAll('"', ""));
    }
  }
  return versions;
}

// These floors mirror the first patched releases published for the vulnerable
// major lines currently present in the committed Yarn dependency graph.
const yarnSecurityPatchFloors = Object.freeze({
  "ip-address": Object.freeze({
    minimumMajor: 10,
    floors: Object.freeze({
      10: Object.freeze([10, 3, 1]),
    }),
  }),
  picomatch: Object.freeze({
    minimumMajor: 2,
    floors: Object.freeze({
      2: Object.freeze([2, 3, 2]),
      4: Object.freeze([4, 0, 4]),
    }),
  }),
  postcss: Object.freeze({
    minimumMajor: 8,
    floors: Object.freeze({
      8: Object.freeze([8, 5, 18]),
    }),
  }),
  terser: Object.freeze({
    minimumMajor: 5,
    floors: Object.freeze({
      5: Object.freeze([5, 14, 2]),
    }),
  }),
  undici: Object.freeze({
    minimumMajor: 6,
    floors: Object.freeze({
      6: Object.freeze([6, 28, 0]),
      7: Object.freeze([7, 29, 0]),
      8: Object.freeze([8, 9, 0]),
    }),
  }),
  "websocket-driver": Object.freeze({
    minimumMajor: 0,
    floors: Object.freeze({
      0: Object.freeze([0, 7, 5]),
    }),
  }),
  tar: Object.freeze({
    minimumMajor: 6,
    floors: Object.freeze({
      7: Object.freeze([7, 5, 21]),
    }),
  }),
});

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return Math.sign(left[index] - right[index]);
    }
  }
  return 0;
}

export function validateYarnSecurityGraph(lockfiles) {
  const errors = [];
  for (const [lockfilePath, lockfile] of Object.entries(lockfiles)) {
    for (const [packageName, policy] of Object.entries(
      yarnSecurityPatchFloors,
    )) {
      for (const version of yarnVersions(lockfile, packageName)) {
        const match =
          /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
            version,
          );
        if (!match) {
          errors.push(
            `${lockfilePath}: ${packageName} has an invalid version ${version}`,
          );
          continue;
        }
        const parsed = match.slice(1, 4).map(Number);
        const floor = policy.floors[parsed[0]];
        const isPrerelease = Boolean(match[4]);
        if (
          parsed[0] < policy.minimumMajor ||
          (floor &&
            (compareVersions(parsed, floor) < 0 ||
              (compareVersions(parsed, floor) === 0 && isPrerelease)))
        ) {
          errors.push(
            `${lockfilePath}: ${packageName} ${version} is below its patched security floor`,
          );
        }
      }
    }
  }
  return errors;
}

export function validateAppSecurityGraph(packageJsonText, lockfile) {
  const errors = [];
  const packageJson = JSON.parse(packageJsonText);
  const expectedResolutions = {
    "@grpc/grpc-js@npm:^1.7.1": "1.14.4",
    "@grpc/grpc-js@npm:^1.9.13": "1.14.4",
    "axios@npm:^1.6.1": "1.19.0",
    "body-parser@npm:1.20.1": "1.20.6",
    "fast-xml-parser@npm:4.2.5": "4.5.7",
    "form-data": "4.0.6",
    "jws@npm:^3.2.2": "3.2.3",
    "lodash-es@npm:4.17.21": "4.18.1",
    "nanoid@npm:3.3.3": "3.3.18",
    "path-to-regexp@npm:0.1.7": "0.1.13",
    "path-to-regexp@npm:~0.1.12": "0.1.13",
    protobufjs: "7.6.5",
    "sha.js": "2.4.12",
    "shell-quote": "1.10.0",
    "typeorm@npm:^0.3.17": "0.3.31",
    "websocket-driver": "0.7.5",
  };
  for (const [name, version] of Object.entries(expectedResolutions)) {
    if (packageJson.resolutions?.[name] !== version) {
      errors.push(
        `app/package.json: security resolution ${name} must remain ${version}`,
      );
    }
  }

  const fastXmlVersions = yarnVersions(lockfile, "fast-xml-parser");
  if (!fastXmlVersions.includes("4.5.7")) {
    errors.push("app/yarn.lock: patched fast-xml-parser 4.5.7 is missing");
  }
  if (!fastXmlVersions.some((version) => version.startsWith("5."))) {
    errors.push(
      "app/yarn.lock: the supported fast-xml-parser 5.x graph was collapsed",
    );
  }

  for (const [name, expected] of Object.entries({
    "@grpc/grpc-js": ["1.14.4"],
    axios: ["1.18.1", "1.19.0"],
    "body-parser": ["1.20.5", "1.20.6", "2.2.2"],
    "form-data": ["4.0.6"],
    jws: ["3.2.3", "4.0.1"],
    "path-to-regexp": ["0.1.13"],
    protobufjs: ["7.6.5"],
    "sha.js": ["2.4.12"],
    "shell-quote": ["1.10.0"],
    typeorm: ["0.3.31"],
    "websocket-driver": ["0.7.5"],
  })) {
    const versions = yarnVersions(lockfile, name).sort();
    if (versions.join("\0") !== expected.join("\0")) {
      errors.push(
        `app/yarn.lock: ${name} must resolve exactly to patched graph ${expected.join(", ")}`,
      );
    }
  }

  if (!lockfile.includes("hash=7b308c")) {
    errors.push(
      "app/yarn.lock: embedded home-server loopback patch hash changed",
    );
  }
  if (!lockfile.includes('"pdfjs-dist@npm:6.2.108":')) {
    errors.push("app/yarn.lock: PDF.js must remain on patched 6.2.108");
  }

  return errors;
}

const sheetJsDistribution = Object.freeze({
  url: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
  version: "0.20.3",
  checksum:
    "10/895c589c5f6ffc665184165b5aa5d337de0e2ee24ccd53d517d2378f3a8a7df82405b023fdcfde9f49d7de3d4ef1622cf2ef145316c9732c634a86ee313bad4f",
});

// SheetJS stopped publishing current releases to npm. Dependabot and registry
// audits may not inventory the official CDN tarball, so this lock contract is
// the fail-closed coverage for its source, version, and immutable checksum.
export function validateSheetJsDistribution(
  webPackageJsonText,
  lockfile,
  yarnConfig,
) {
  const errors = [];
  const webPackage = JSON.parse(webPackageJsonText);
  if (webPackage.dependencies?.xlsx !== sheetJsDistribution.url) {
    errors.push(
      `app/packages/web/package.json: xlsx must remain pinned to ${sheetJsDistribution.url}`,
    );
  }

  const expectedHeader = `"xlsx@${sheetJsDistribution.url}":`;
  const xlsxHeaders = lockfile.match(/^"xlsx@[^\n]+":$/gmu) ?? [];
  if (xlsxHeaders.length !== 1 || xlsxHeaders[0] !== expectedHeader) {
    errors.push(
      "app/yarn.lock: xlsx must have exactly one official SheetJS distribution entry",
    );
  }

  const entryStart = lockfile.indexOf(expectedHeader);
  const entryEnd = lockfile.indexOf("\n\n", entryStart);
  const entry =
    entryStart >= 0
      ? lockfile.slice(entryStart, entryEnd >= 0 ? entryEnd : lockfile.length)
      : "";
  if (!entry.includes(`\n  version: ${sheetJsDistribution.version}\n`)) {
    errors.push(
      `app/yarn.lock: xlsx must remain version ${sheetJsDistribution.version}`,
    );
  }
  if (!entry.includes(`\n  resolution: "xlsx@${sheetJsDistribution.url}"\n`)) {
    errors.push("app/yarn.lock: xlsx resolution source changed");
  }
  if (!entry.includes(`\n  checksum: ${sheetJsDistribution.checksum}\n`)) {
    errors.push("app/yarn.lock: xlsx immutable checksum changed");
  }
  if (!/^checksumBehavior:\s*throw\s*$/mu.test(yarnConfig)) {
    errors.push("app/.yarnrc.yml: checksum failures must remain fatal");
  }
  if (!/^enableImmutableInstalls:\s*true\s*$/mu.test(yarnConfig)) {
    errors.push("app/.yarnrc.yml: immutable installs must remain enabled");
  }

  return errors;
}

function runAudit(domain, root, runner = spawnSync) {
  const cwd = path.join(root, domain.directory);
  const tool =
    domain.manager === "yarn" ? executable("corepack") : executable("npm");
  const toolArgs =
    domain.manager === "yarn"
      ? [
          "yarn",
          "npm",
          "audit",
          "--all",
          "--recursive",
          "--environment",
          "production",
          "--severity",
          enforcementSeverity,
          "--no-deprecations",
          "--json",
        ]
      : [
          "audit",
          "--package-lock-only",
          "--omit=dev",
          `--audit-level=${enforcementSeverity}`,
          "--ignore-scripts",
          "--json",
        ];
  const [command, args] =
    process.platform === "win32"
      ? [
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [tool, ...toolArgs].join(" ")],
        ]
      : [tool, toolArgs];
  const result = runner(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(
      `${domain.id}: could not execute ${domain.manager} audit: ${result.error.message}`,
    );
  }
  const advisories =
    domain.manager === "yarn"
      ? parseYarnAudit(result.stdout ?? "", domain.id)
      : parseNpmAudit(result.stdout ?? "", domain.id);
  const enforceable = enforceableAdvisories(advisories);
  if (result.status !== 0 && !(result.status === 1 && enforceable.length > 0)) {
    const diagnostic = String(result.stderr ?? "").trim();
    throw new Error(
      `${domain.id}: ${domain.manager} audit exited ${result.status}${diagnostic ? `: ${diagnostic}` : " without a parseable advisory"}`,
    );
  }
  return enforceable;
}

export function runProductionAudit(root = repositoryRoot, runner = spawnSync) {
  const git = runner(executable("git"), ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (git.status !== 0 || git.error) {
    throw new Error(
      `could not inventory committed lockfiles: ${git.error?.message ?? git.stderr}`,
    );
  }

  const inventoryErrors = validateLockfileInventory(
    trackedLockfilesFromGitOutput(git.stdout),
  );
  if (inventoryErrors.length > 0) {
    throw new Error(
      `production dependency audit inventory failed:\n- ${inventoryErrors.join("\n- ")}`,
    );
  }

  const appLockfile = fs.readFileSync(
    path.join(root, "app", "yarn.lock"),
    "utf8",
  );
  const graphErrors = [
    ...validateAppSecurityGraph(
      fs.readFileSync(path.join(root, "app", "package.json"), "utf8"),
      appLockfile,
    ),
    ...validateSheetJsDistribution(
      fs.readFileSync(
        path.join(root, "app", "packages", "web", "package.json"),
        "utf8",
      ),
      appLockfile,
      fs.readFileSync(path.join(root, "app", ".yarnrc.yml"), "utf8"),
    ),
  ];
  if (graphErrors.length > 0) {
    throw new Error(
      `production dependency graph contract failed:\n- ${graphErrors.join("\n- ")}`,
    );
  }

  const yarnGraphErrors = validateYarnSecurityGraph(
    Object.fromEntries(
      auditDomains
        .filter((domain) => domain.manager === "yarn")
        .map((domain) => [
          domain.lockfile,
          fs.readFileSync(path.join(root, domain.lockfile), "utf8"),
        ]),
    ),
  );
  if (yarnGraphErrors.length > 0) {
    throw new Error(
      `production Yarn dependency graph contract failed:\n- ${yarnGraphErrors.join("\n- ")}`,
    );
  }

  const advisories = auditDomains.flatMap((domain) =>
    runAudit(domain, root, runner),
  );
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const allowlistErrors = validateAllowlist(advisories, allowlist, today);
  if (allowlistErrors.length > 0) {
    throw new Error(
      `production dependency audit failed:\n- ${allowlistErrors.join("\n- ")}`,
    );
  }

  return { domains: auditDomains.length, advisories, allowlist };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = runProductionAudit();
    console.log(
      `Production dependency audit passed across ${result.domains} committed lock domains; ` +
        `${result.advisories.length} critical advisory exception is active and expires ${result.allowlist[0]?.expiry ?? "n/a"}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
