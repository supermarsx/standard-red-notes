import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditDomains,
  enforceableAdvisories,
  parseNpmAudit,
  parseYarnAudit,
  trackedLockfilesFromGitOutput,
  validateAllowlist,
  validateAppSecurityGraph,
  validateLockfileInventory,
  validateSheetJsDistribution,
  validateYarnSecurityGraph,
} from "./audit-production-dependencies.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appPackage = fs.readFileSync(
  path.join(repositoryRoot, "app", "package.json"),
  "utf8",
);
const appLock = fs.readFileSync(
  path.join(repositoryRoot, "app", "yarn.lock"),
  "utf8",
);
const appYarnConfig = fs.readFileSync(
  path.join(repositoryRoot, "app", ".yarnrc.yml"),
  "utf8",
);
const webPackage = fs.readFileSync(
  path.join(repositoryRoot, "app", "packages", "web", "package.json"),
  "utf8",
);
const yarnLockfiles = Object.fromEntries(
  auditDomains
    .filter((domain) => domain.manager === "yarn")
    .map((domain) => [
      domain.lockfile,
      fs.readFileSync(path.join(repositoryRoot, domain.lockfile), "utf8"),
    ]),
);

const tarAdvisory = {
  domain: "app",
  advisoryId: "1123940",
  package: "tar",
  severity: "critical",
  vulnerableVersions: "<=7.5.18",
  versions: ["6.2.1"],
  dependents: ["node-gyp@npm:9.4.0"],
};
const tarException = {
  advisoryId: "1123940",
  package: "tar",
  domain: "app",
  vulnerableVersions: "<=7.5.18",
  versions: ["6.2.1"],
  dependents: ["node-gyp@npm:9.4.0"],
  rationale:
    "The affected tar line is build-only and has no compatible patched major.",
  expiry: "2026-11-01",
};

test("every committed JavaScript lock domain is explicitly covered", () => {
  const tracked =
    auditDomains.map((domain) => domain.lockfile).join("\0") + "\0";
  assert.deepEqual(
    validateLockfileInventory(trackedLockfilesFromGitOutput(tracked)),
    [],
  );

  assert.match(
    validateLockfileInventory([
      ...auditDomains.map((domain) => domain.lockfile),
      "new-service/package-lock.json",
    ]).join("\n"),
    /uncovered committed lockfiles: new-service\/package-lock\.json/,
  );
});

test("Yarn NDJSON and npm JSON advisories are parsed into one contract", () => {
  const yarn = parseYarnAudit(
    JSON.stringify({
      value: "tar",
      children: {
        ID: 1123940,
        Issue: "unsafe extraction",
        URL: "https://example.invalid/advisory",
        Severity: "critical",
        "Vulnerable Versions": "<=7.5.18",
        "Tree Versions": ["6.2.1"],
        Dependents: ["node-gyp@npm:9.4.0"],
      },
    }),
    "app",
  );
  assert.deepEqual(yarn[0], {
    ...tarAdvisory,
    title: "unsafe extraction",
    url: "https://example.invalid/advisory",
  });

  const npm = parseNpmAudit(
    JSON.stringify({
      vulnerabilities: {
        tar: {
          via: [
            {
              source: 1123940,
              name: "tar",
              severity: "critical",
              title: "unsafe extraction",
              url: "https://example.invalid/advisory",
            },
          ],
        },
      },
    }),
    "cli-client",
  );
  assert.equal(npm[0].domain, "cli-client");
  assert.equal(npm[0].advisoryId, "1123940");
});

test("the gate fails closed on new critical advisories", () => {
  const errors = validateAllowlist(
    [
      tarAdvisory,
      {
        domain: "server",
        advisoryId: "9999999",
        package: "new-risk",
        severity: "critical",
      },
    ],
    [tarException],
    "2026-08-10",
  );
  assert.match(errors.join("\n"), /unallowlisted critical advisory 9999999/);
});

test("expired, duplicate, and unused exceptions fail closed", () => {
  const expired = { ...tarException, expiry: "2026-08-09" };
  assert.match(
    validateAllowlist([tarAdvisory], [expired], "2026-08-10").join("\n"),
    /expired on 2026-08-09/,
  );
  assert.match(
    validateAllowlist(
      [tarAdvisory],
      [tarException, tarException],
      "2026-08-10",
    ).join("\n"),
    /duplicate advisory exception/,
  );
  assert.match(
    validateAllowlist([], [tarException], "2026-08-10").join("\n"),
    /stale or unused exception 1123940/,
  );
  assert.match(
    validateAllowlist(
      [tarAdvisory],
      [{ ...tarException, expiry: "2026-02-30" }],
      "2026-08-10",
    ).join("\n"),
    /expiry must be a real UTC date using YYYY-MM-DD/,
  );
});

test("an exception is bound to the audited range, versions, and dependents", () => {
  for (const advisory of [
    { ...tarAdvisory, vulnerableVersions: "<=7.5.19" },
    { ...tarAdvisory, versions: ["6.2.1", "7.5.18"] },
    { ...tarAdvisory, dependents: ["pacote@npm:21.5.1"] },
  ]) {
    assert.match(
      validateAllowlist([advisory], [tarException], "2026-08-10").join("\n"),
      /exception evidence changed/,
    );
  }

  const mergedPaths = enforceableAdvisories([
    tarAdvisory,
    {
      ...tarAdvisory,
      versions: ["7.5.18"],
      dependents: ["pacote@npm:21.5.1"],
    },
  ]);
  assert.deepEqual(mergedPaths[0].versions, ["6.2.1", "7.5.18"]);
  assert.deepEqual(mergedPaths[0].dependents, [
    "node-gyp@npm:9.4.0",
    "pacote@npm:21.5.1",
  ]);
  assert.match(
    validateAllowlist(mergedPaths, [tarException], "2026-08-10").join("\n"),
    /exception evidence changed/,
  );
});

test("only critical production advisories reach the exception policy", () => {
  assert.deepEqual(
    enforceableAdvisories([
      { ...tarAdvisory, severity: "high" },
      tarAdvisory,
      tarAdvisory,
    ]),
    [tarAdvisory],
  );
});

test("the app security graph preserves patched legacy and current majors", () => {
  assert.deepEqual(validateAppSecurityGraph(appPackage, appLock), []);

  assert.match(
    validateAppSecurityGraph(
      appPackage,
      appLock.replace(/"fast-xml-parser@npm:\^5\.3\.6":[\s\S]*?\n\n/u, ""),
    ).join("\n"),
    /supported fast-xml-parser 5\.x graph was collapsed/,
  );
  assert.match(
    validateAppSecurityGraph(
      appPackage,
      appLock.replace(
        '"axios@npm:^1.18.1, axios@npm:^1.6.7":\n  version: 1.18.1',
        '"axios@npm:^1.18.1, axios@npm:^1.6.7":\n  version: 1.17.9',
      ),
    ).join("\n"),
    /axios must resolve exactly to patched graph 1\.18\.1, 1\.19\.0/,
  );
  assert.match(
    validateAppSecurityGraph(
      appPackage.replace(
        '"fast-xml-parser@npm:4.2.5": "4.5.7"',
        '"fast-xml-parser": "4.5.7"',
      ),
      appLock,
    ).join("\n"),
    /security resolution fast-xml-parser@npm:4\.2\.5 must remain 4\.5\.7/,
  );
  assert.match(
    validateAppSecurityGraph(
      appPackage.replace(
        '"nanoid@npm:3.3.3": "3.3.18"',
        '"nanoid@npm:3.3.3": "3.3.3"',
      ),
      appLock,
    ).join("\n"),
    /security resolution nanoid@npm:3\.3\.3 must remain 3\.3\.18/,
  );
  assert.match(
    validateAppSecurityGraph(
      appPackage.replace(
        '"lodash-es@npm:4.17.21": "4.18.1"',
        '"lodash-es@npm:4.17.21": "4.17.21"',
      ),
      appLock,
    ).join("\n"),
    /security resolution lodash-es@npm:4\.17\.21 must remain 4\.18\.1/,
  );
  assert.match(
    validateAppSecurityGraph(
      appPackage,
      appLock.replace("hash=7b308c", "hash=000000"),
    ).join("\n"),
    /loopback patch hash changed/,
  );
});

test("every Yarn domain keeps security-sensitive packages on patched floors", () => {
  assert.deepEqual(validateYarnSecurityGraph(yarnLockfiles), []);

  for (const [
    lockfile,
    packageName,
    descriptor,
    safeVersion,
    vulnerableVersion,
  ] of [
    ["app/yarn.lock", "adm-zip", '"adm-zip@npm:~0.6.x":', "0.6.0", "0.5.10"],
    [
      "server/yarn.lock",
      "ip-address",
      '"ip-address@npm:^10.1.1":',
      "10.5.0",
      "10.3.0",
    ],
    [
      "app/yarn.lock",
      "picomatch",
      '"picomatch@npm:^2.0.4, picomatch@npm:^2.2.1, picomatch@npm:^2.2.3, picomatch@npm:^2.3.1":',
      "2.3.2",
      "2.3.1",
    ],
    [
      "app/yarn.lock",
      "picomatch",
      '"picomatch@npm:^4.0.0, picomatch@npm:^4.0.2, picomatch@npm:^4.0.3, picomatch@npm:^4.0.4":',
      "4.0.5",
      "4.0.3",
    ],
    ["yarn.lock", "postcss", '"postcss@npm:^8.5.15":', "8.5.26", "8.5.17"],
    [
      "app/packages/filepicker/example/yarn.lock",
      "terser",
      '"terser@npm:^5.10.0, terser@npm:^5.31.1":',
      "5.49.2",
      "5.14.1",
    ],
    ["app/yarn.lock", "undici", '"undici@npm:^6.25.0":', "6.28.0", "6.26.0"],
    [
      "app/yarn.lock",
      "undici",
      '"undici@npm:^7.19.0, undici@npm:^7.24.4, undici@npm:^7.25.0":',
      "7.29.0",
      "7.27.0",
    ],
    ["yarn.lock", "undici", '"undici@npm:^8.4.1":', "8.10.0", "8.7.0"],
    [
      "app/packages/filepicker/example/yarn.lock",
      "websocket-driver",
      '"websocket-driver@npm:>=0.5.1, websocket-driver@npm:^0.7.4":',
      "0.7.5",
      "0.7.4",
    ],
    [
      "app/yarn.lock",
      "tar",
      '"tar@npm:^7.4.0, tar@npm:^7.4.3, tar@npm:^7.5.19, tar@npm:^7.5.4, tar@npm:^7.5.7":',
      "7.5.22",
      "7.5.20",
    ],
  ]) {
    const vulnerable = {
      ...yarnLockfiles,
      [lockfile]: yarnLockfiles[lockfile].replace(
        `${descriptor}\n  version: ${safeVersion}`,
        `${descriptor}\n  version: ${vulnerableVersion}`,
      ),
    };
    assert.match(
      validateYarnSecurityGraph(vulnerable).join("\n"),
      new RegExp(
        `${lockfile.replaceAll(".", "\\.")}: ${packageName} ${vulnerableVersion.replaceAll(".", "\\.")} is below its patched security floor`,
      ),
    );
  }

  const prerelease = {
    ...yarnLockfiles,
    "app/yarn.lock": yarnLockfiles["app/yarn.lock"].replace(
      '"undici@npm:^6.25.0":\n  version: 6.28.0',
      '"undici@npm:^6.25.0":\n  version: 6.28.0-rc.1',
    ),
  };
  assert.match(
    validateYarnSecurityGraph(prerelease).join("\n"),
    /undici 6\.28\.0-rc\.1 is below its patched security floor/,
  );

  const buildMetadata = {
    ...yarnLockfiles,
    "app/yarn.lock": yarnLockfiles["app/yarn.lock"].replace(
      '"undici@npm:^6.25.0":\n  version: 6.28.0',
      '"undici@npm:^6.25.0":\n  version: 6.28.0+build.1',
    ),
  };
  assert.deepEqual(validateYarnSecurityGraph(buildMetadata), []);
});

test("the official SheetJS distribution stays source- and checksum-pinned", () => {
  assert.deepEqual(
    validateSheetJsDistribution(webPackage, appLock, appYarnConfig),
    [],
  );

  assert.match(
    validateSheetJsDistribution(
      webPackage.replace("xlsx-0.20.3", "xlsx-0.20.2"),
      appLock,
      appYarnConfig,
    ).join("\n"),
    /xlsx must remain pinned to https:\/\/cdn\.sheetjs\.com\/xlsx-0\.20\.3/,
  );
  assert.match(
    validateSheetJsDistribution(
      webPackage,
      appLock.replace("  version: 0.20.3", "  version: 0.20.2"),
      appYarnConfig,
    ).join("\n"),
    /xlsx must remain version 0\.20\.3/,
  );
  assert.match(
    validateSheetJsDistribution(
      webPackage,
      appLock.replace(
        "10/895c589c5f6ffc665184165b5aa5d337de0e2ee24ccd53d517d2378f3a8a7df82405b023fdcfde9f49d7de3d4ef1622cf2ef145316c9732c634a86ee313bad4f",
        "10/00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      ),
      appYarnConfig,
    ).join("\n"),
    /xlsx immutable checksum changed/,
  );
  assert.match(
    validateSheetJsDistribution(
      webPackage,
      appLock,
      appYarnConfig.replace(
        "checksumBehavior: throw",
        "checksumBehavior: reset",
      ),
    ).join("\n"),
    /checksum failures must remain fatal/,
  );
});
