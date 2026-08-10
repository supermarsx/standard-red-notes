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

const tarAdvisory = {
  domain: "app",
  advisoryId: "1123940",
  package: "tar",
  severity: "critical",
};
const tarException = {
  advisoryId: "1123940",
  package: "tar",
  domain: "app",
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
      appPackage,
      appLock.replace("hash=7b308c", "hash=000000"),
    ).join("\n"),
    /loopback patch hash changed/,
  );
});
