import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { githubOutputs } from "./analyze-release-impact.mjs";
import { approvedWorkflowAction } from "./validate-ci-contract.mjs";
import {
  loadReleaseContractFiles,
  runReleaseContractValidation,
  validateReleaseContract,
} from "./validate-release-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseline = loadReleaseContractFiles(repositoryRoot);
const require = createRequire(import.meta.url);
const notarizeMac = require(
  path.join(
    repositoryRoot,
    "app",
    "packages",
    "desktop",
    "scripts",
    "notarizeMac.js",
  ),
);
const { windowsSign } = require(
  path.join(
    repositoryRoot,
    "app",
    "packages",
    "desktop",
    "scripts",
    "windowsSign.js",
  ),
);

function withFileChanged(file, update) {
  const files = new Map(baseline);
  const original = files.get(file);
  const changed = update(original);
  assert.notEqual(changed, original, `mutation must change ${file}`);
  files.set(file, changed);
  return files;
}

function withJobChanged(file, jobName, nextJobName, update) {
  return withFileChanged(file, (content) => {
    const start = content.indexOf(`\n  ${jobName}:`);
    const end = content.indexOf(`\n  ${nextJobName}:`, start);
    assert.notEqual(start, -1, `${file} must contain ${jobName}`);
    assert.notEqual(end, -1, `${file} must contain ${nextJobName}`);
    return `${content.slice(0, start)}${update(content.slice(start, end))}${content.slice(end)}`;
  });
}

function withTerminalJobChanged(file, jobName, update) {
  return withFileChanged(file, (content) => {
    const start = content.indexOf(`\n  ${jobName}:`);
    assert.notEqual(start, -1, `${file} must contain ${jobName}`);
    return `${content.slice(0, start)}${update(content.slice(start))}`;
  });
}

test("the repository satisfies the release contract", () => {
  assert.deepEqual(validateReleaseContract(baseline), []);
});

const macHookParameters = Object.freeze({
  electronPlatformName: "darwin",
  appOutDir: "/tmp/output",
  packager: { appInfo: { productFilename: "Standard Red Notes" } },
});

const completeAppleEnvironment = Object.freeze({
  REQUIRE_DESKTOP_AUTHENTICITY: "true",
  APPLE_TEAM_ID: "TESTTEAM1",
  NOTARIZE_APPLE_ID: "release@example.invalid",
  NOTARIZE_APPLE_ID_PASSWORD: "test-only-password",
});

function macHookDependencies(overrides = {}) {
  return {
    env: completeAppleEnvironment,
    fsPromises: {
      access: async () => {},
      readFile: async () =>
        JSON.stringify({ build: { appId: "org.standardrednotes.test" } }),
    },
    log: () => {},
    ...overrides,
  };
}

test("production desktop hooks fail closed when authenticity credentials are missing", async () => {
  await assert.rejects(
    notarizeMac(macHookParameters, {
      env: { REQUIRE_DESKTOP_AUTHENTICITY: "true" },
      log: () => {},
    }),
    /APPLE_TEAM_ID, NOTARIZE_APPLE_ID, NOTARIZE_APPLE_ID_PASSWORD/,
  );
  await assert.rejects(
    windowsSign(
      { path: "C:\\build\\Standard Red Notes.exe" },
      {
        env: { REQUIRE_DESKTOP_AUTHENTICITY: "true" },
        log: () => {},
      },
    ),
    /SM_KEYPAIR_ALIAS/,
  );
});

test("explicitly non-publishing desktop hooks preserve unsigned local builds", async () => {
  const messages = [];
  await notarizeMac(macHookParameters, {
    env: {},
    log: (message) => messages.push(message),
  });
  await windowsSign(
    { path: "C:\\build\\Standard Red Notes.exe" },
    { env: {}, log: (message) => messages.push(message) },
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0], /non-publishing build/);
  assert.match(messages[1], /non-publishing build/);
});

test("macOS notarization and stapling are awaited in order", async () => {
  const events = [];
  let releaseNotarization;
  const notarizationGate = new Promise((resolve) => {
    releaseNotarization = resolve;
  });
  let completed = false;
  const hook = notarizeMac(
    macHookParameters,
    macHookDependencies({
      electronNotarize: {
        notarize: async () => {
          events.push("notarize-start");
          await notarizationGate;
          events.push("notarize-finish");
        },
        staple: async () => events.push("staple"),
      },
    }),
  ).then(() => {
    completed = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(events, ["notarize-start"]);
  releaseNotarization();
  await hook;
  assert.deepEqual(events, ["notarize-start", "notarize-finish", "staple"]);
});

test("macOS notarization failures reject the electron-builder hook", async () => {
  await assert.rejects(
    notarizeMac(
      macHookParameters,
      macHookDependencies({
        electronNotarize: {
          notarize: async () => {
            throw new Error("notary service rejected upload");
          },
          staple: async () =>
            assert.fail("staple must not run after rejection"),
        },
      }),
    ),
    /notary service rejected upload/,
  );
});

test("Windows signing passes aliases and paths without shell interpolation", async () => {
  const calls = [];
  const alias = 'release-key" & echo injected';
  const artifact = "C:\\build output\\Standard Red Notes & Notes.exe";
  await windowsSign(
    { path: artifact },
    {
      env: {
        REQUIRE_DESKTOP_AUTHENTICITY: "true",
        SM_KEYPAIR_ALIAS: alias,
      },
      execFileSync: (...args) => calls.push(args),
    },
  );
  assert.deepEqual(calls, [
    [
      "smctl",
      ["sign", "--keypair-alias", alias, "--input", artifact, "--verbose"],
      { stdio: "inherit" },
    ],
  ]);
});

test("desktop authenticity fail-closed controls are mutation protected", () => {
  for (const [file, before, after, expected] of [
    [
      "app/packages/desktop/scripts/notarizeMac.js",
      "await electronNotarize.notarize({",
      "electronNotarize.notarize({",
      /missing awaited Apple notarization submission/,
    ],
    [
      "app/packages/desktop/scripts/notarizeMac.js",
      "      throw new Error(message)",
      "      return log(message)",
      /missing production Apple credential failure/,
    ],
    [
      "app/packages/desktop/scripts/notarizeMac.js",
      "await electronNotarize.staple({ appPath })",
      "electronNotarize.staple({ appPath })",
      /missing awaited Apple notarization ticket stapling/,
    ],
    [
      "app/packages/desktop/scripts/windowsSign.js",
      "  run('smctl',",
      "  execSync('smctl',",
      /must not interpolate credentials or paths/,
    ],
    [
      "app/packages/desktop/scripts/windowsSign.js",
      "      throw new Error(message)",
      "      return log(message)",
      /missing production Windows credential failure/,
    ],
    [
      "app/packages/desktop/build/entitlements.mac.inherit.plist",
      "<key>com.apple.security.cs.allow-jit</key>",
      "<key>com.apple.security.cs.allow-jit-disabled</key>",
      /missing Electron JIT entitlement/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "Verify macOS signatures and stapled notarization tickets",
      "Verify macOS build outputs",
      /missing macOS signature and notarization verification/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "Verify Windows published and runtime signatures and timestamps",
      "Verify Windows build outputs",
      /missing Windows signature verification/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "          SM_CLIENT_TOOLS_MSI_SHA256: ${{ secrets.SM_CLIENT_TOOLS_MSI_SHA256 }}\n",
      "",
      /missing DigiCert client tools MSI hash secret/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "if ($actualMsiHash -ne $expectedMsiHash)",
      "if ($actualMsiHash -eq $expectedMsiHash)",
      /missing fail-closed DigiCert MSI hash comparison/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "$msiSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid",
      "$msiSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid",
      /missing fail-closed DigiCert MSI Authenticode validation/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "if (@(0, 1641, 3010) -notcontains $installer.ExitCode)",
      "if ($false)",
      /missing bounded DigiCert MSI success exit codes/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "& $smctl.Source healthcheck",
      "& $smctl.Source --version",
      /missing DigiCert credential health check/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "if ($LASTEXITCODE -ne 0)",
      "if ($LASTEXITCODE -eq 0)",
      /missing fail-closed DigiCert credential health check/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "https://one.digicert.com/signingmanager/api-ui/v1/releases/Keylockertools-windows-x64.msi/download",
      "http://downloads.example.invalid/keylocker.msi",
      /missing official DigiCert client tools HTTPS endpoint/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "if: always() && runner.os == 'Windows'",
      "if: runner.os == 'Windows'",
      /missing unconditional Windows signing material cleanup/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "            'dist/win-arm64-unpacked/standard-red-notes.exe'\n",
      "",
      /missing Windows ARM64 unpacked runtime signature target/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "Verify macOS signatures and stapled notarization tickets",
      "Verify macOS build outputs",
      /missing macOS signature and notarization verification/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "Verify Windows published and runtime signatures and timestamps",
      "Verify Windows build outputs",
      /missing Windows signature verification/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "          SM_CLIENT_TOOLS_MSI_SHA256: ${{ secrets.SM_CLIENT_TOOLS_MSI_SHA256 }}\n",
      "",
      /missing DigiCert client tools MSI hash secret/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "if ($toolsUri.Scheme -ne 'https' -or $toolsUri.Host -ne 'one.digicert.com')",
      "if ($false)",
      /missing official DigiCert client tools authority enforcement/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "            'dist/win-unpacked/standard-red-notes.exe',\n",
      "",
      /missing Windows x64 unpacked runtime signature target/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(before, after),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  const unprotectedWindows = withJobChanged(
    "app/.github/workflows/desktop.release.reuse.yml",
    "Windows",
    "Linux-AppImage-X64",
    (job) =>
      job.replace("environment: release-production", "environment: test"),
  );
  assert.match(
    validateReleaseContract(unprotectedWindows).join("\n"),
    /missing Windows protected production environment|must be scoped exactly to macOS signing, Windows signing/,
  );
});

test("YAML scalar quote-only formatting does not change release validation", () => {
  const files = new Map(baseline);
  for (const [file, replacements] of [
    [
      ".github/workflows/srn-client.yml",
      [
        [
          '- "scripts/native-cli-release.mjs"',
          "- 'scripts/native-cli-release.mjs'",
        ],
        ['NODE_VERSION: "26"', "NODE_VERSION: '26'"],
      ],
    ],
    [
      ".github/workflows/srn-desktop.yml",
      [
        ['- "app/packages/**"', "- 'app/packages/**'"],
        [
          'builder: "--mac dmg zip --x64 --arm64"',
          "builder: '--mac dmg zip --x64 --arm64'",
        ],
        ['python-version: "3.14.6"', "python-version: '3.14.6'"],
      ],
    ],
    [
      ".github/workflows/srn-mobile.yml",
      [
        ['java-version: "17"', "java-version: '17'"],
        ['ruby-version: "3.4.7"', "ruby-version: '3.4.7'"],
        ['xcode-version: "26"', "xcode-version: '26'"],
      ],
    ],
    [
      ".github/workflows/release-contract.yml",
      [
        [
          '- ".github/workflows/srn-mobile.yml"',
          "- '.github/workflows/srn-mobile.yml'",
        ],
      ],
    ],
  ]) {
    const original = files.get(file);
    let changed = original;
    for (const [before, after] of replacements) {
      changed = changed.replaceAll(before, after);
    }
    assert.notEqual(changed, original, `quote mutation must change ${file}`);
    files.set(file, changed);
  }
  assert.deepEqual(validateReleaseContract(files), []);
});

test("the release validator CLI executes without a top-level crash", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "validate-release-contract.mjs")],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Release contract valid:/);
});

test("release payload integrity steps cannot be separated from their consumers", () => {
  for (const [file, consumer, expected] of [
    [
      ".github/workflows/srn-client.yml",
      "      - name: Upload packaged binaries",
      /package integrity step 'Generate checksums' must be immediately followed/,
    ],
    [
      ".github/workflows/srn-openclaw.yml",
      "      - name: Upload attested release package",
      /attest integrity step 'Add provenance bundle and verify final checksums' must be immediately followed/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "      - name: Upload exact desktop release payload",
      /fan_in integrity step 'Validate authorities, reject collisions, and checksum payload' must be immediately followed/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "      - name: Upload immutable publication payload",
      /FanIn integrity step 'Validate authorities, reject collisions, and build exact inventory' must be immediately followed/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(
        consumer,
        "      - run: echo tamper-after-verification\n\n" + consumer,
      ),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("terminal checksum commands cannot gain a post-verification mutation", () => {
  for (const [file, fragment, expected] of [
    [
      ".github/workflows/srn-client.yml",
      "          sha256sum --check SHA256SUMS.txt\n\n      - name: Upload packaged binaries",
      /native checksum verification must be the final command before packaged upload/,
    ],
    [
      ".github/workflows/srn-openclaw.yml",
      "          (cd out && sha256sum --check SHA256SUMS.txt)\n\n      - name: Upload attested release package",
      /provenance and checksum verification must be terminal before attested upload/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      "          (cd payload && sha256sum --check SHA256SUMS.txt)\n\n      - name: Upload exact desktop release payload",
      /desktop fan-in checksum verification must be terminal before upload/,
    ],
    [
      ".github/workflows/srn-desktop.yml",
      '            "${checksum_check[@]}" "$leg_manifest"\n          )\n\n      - name: Upload installers',
      /per-leg desktop checksum verification must be terminal before upload/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(
        fragment,
        fragment.replace(
          "\n\n      - name:",
          "\n          echo tamper-after-check\n\n      - name:",
        ),
      ),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("pinned but unplanned actions cannot cross release security boundaries", () => {
  for (const [file, marker, injected, expected] of [
    [
      ".github/workflows/srn-client.yml",
      "      - name: Upload packaged binaries",
      "      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n\n",
      /package action sequence must be exactly/,
    ],
    [
      ".github/workflows/srn-openclaw.yml",
      "      - name: Upload attested release package",
      "      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n\n",
      /attest action sequence must be exactly/,
    ],
    [
      "app/.github/workflows/desktop.release.reuse.yml",
      "      - name: Upload\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
      "      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n\n",
      /Mac action sequence must be exactly/,
    ],
    [
      ".github/workflows/release-contract.yml",
      "      - name: Upload machine and readable release reports",
      "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n\n",
      /validate action sequence must be exactly/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(marker, injected + marker),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("release validation reports all four mobile publication stages", () => {
  const result = runReleaseContractValidation(repositoryRoot);
  assert.equal(result.mobilePublicationStages, 4);
  assert.equal("mobilePublishers" in result, false);
});

test("mobile root and recovery job graphs remain exact", () => {
  let files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(
      "  release:\n",
      "  shadow_publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  release:\n",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: job set must exactly match the release contract/,
  );

  files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(
      "needs: [version, decide, validated, publish_android, submit_ios]",
      "needs: [version, decide, validated, publish_android]",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: release dependencies must be exactly/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) =>
      content.replace(
        "needs: [context, validated, distribute_ios]",
        "needs: [context, validated]",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /mobile\.release\.prod\.yml: submit_ios dependencies must be exactly/,
  );
});

test("mobile action boundaries, checkout credentials, and recovery retention remain exact", () => {
  let files = withJobChanged(
    ".github/workflows/srn-mobile.yml",
    "android",
    "ios",
    (job) =>
      job.replace(
        "      - name: Upload validated Android artifacts",
        "      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n\n      - name: Upload validated Android artifacts",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: android action sequence must be exactly/,
  );

  files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace("persist-credentials: false", "persist-credentials: true"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /every mobile checkout must disable credential persistence/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) => content.replace("retention-days: 30", "retention-days: 2"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /every mobile artifact and intent marker must retain for exactly 30 days/,
  );
});

test("mobile production credentials and recovery entry stay protected", () => {
  let files = withJobChanged(
    ".github/workflows/srn-mobile.yml",
    "reserve_release",
    "android",
    (job) => job.replace("    environment: mobile-production\n", ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /reserve_release protected production environment/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) =>
      content.replace(
        "on:\n  workflow_dispatch:",
        "on:\n  push:\n  workflow_dispatch:",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /recovery publisher must remain manual-only/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) =>
      content.replace(
        '[ "$GITHUB_REF" != refs/heads/main ] || [ "$GITHUB_SHA" != "$protected_sha" ]',
        "false",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing recovery protected-main head equality guard/,
  );
});

test("mobile GitHub publication can only adopt its early marker-bound draft", () => {
  let files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(
      'gh release upload "$RELEASE_TAG" "${release_files[@]}" --clobber',
      'gh release create "$RELEASE_TAG" --draft',
    ),
  );
  let errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /final mobile publication must adopt the early draft/);
  assert.match(errors, /must create at most one exact marker-bound draft/);

  files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(";fingerprint=${FINGERPRINT};", ";"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing run\/commit\/version\/fingerprint release reservation marker/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) =>
      content.replaceAll("verify_remote_assets", "skip_remote_assets"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing remote GitHub asset verification/,
  );
});

test("mobile platform identity and export-compliance inputs cannot drift", () => {
  let files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(
      "EXPECTED_ANDROID_UPLOAD_CERT_SHA256: ${{ secrets.EXPECTED_ANDROID_UPLOAD_CERT_SHA256 }}",
      "EXPECTED_ANDROID_UPLOAD_CERT_SHA256: legacy-debug-key",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing protected Android upload-certificate fingerprint/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) =>
      content.replaceAll(
        "IOS_USES_NON_EXEMPT_ENCRYPTION: ${{ vars.IOS_USES_NON_EXEMPT_ENCRYPTION }}",
        "IOS_USES_NON_EXEMPT_ENCRYPTION: false",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing operator-reviewed iOS encryption classification/,
  );

  files = withFileChanged("app/packages/mobile/fastlane/Fastfile", (content) =>
    content.replace(
      "plist['ITSAppUsesNonExemptEncryption'] = export_compliance[:uses_non_exempt_encryption]",
      "plist['ITSAppUsesNonExemptEncryption'] = false",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Fastlane embedded export classification/,
  );
});

test("mobile provider stages persist intent before exact mutation and proof", () => {
  let files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replace(
      "      - name: Publish or verify exact Google Play bundle digest and track state",
      "      - run: echo bypass\n\n      - name: Publish or verify exact Google Play bundle digest and track state",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /integrity step 'Persist Google Play intent before external mutation' must be immediately followed/,
  );

  files = withFileChanged(
    "app/.github/workflows/mobile.release.prod.yml",
    (content) => content.replace(".remoteMd5 == $md5", "true"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing upload_ios exact provider-state proof 'remoteMd5 == \$md5'/,
  );

  files = withFileChanged(".github/workflows/srn-mobile.yml", (content) =>
    content.replaceAll(
      "standard-red-notes-ios-arm64-${VERSION}.ipa",
      "standard-red-notes-ios-${VERSION}.ipa",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing validated mobile release file 'standard-red-notes-ios-arm64-<version>\.ipa'/,
  );
});

test("partial TestFlight state must reconcile exactly the missing same-run operation", () => {
  for (const file of [
    ".github/workflows/srn-mobile.yml",
    "app/.github/workflows/mobile.release.prod.yml",
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(
        /(pending:true\)[\s\S]*?echo 'create_marker=false' >> "\$GITHUB_OUTPUT"; echo 'mutation_required=)true/,
        "$1false",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /same-run partial-state idempotent reconciliation/,
    );
  }

  const files = withFileChanged(
    "app/packages/mobile/fastlane/Fastfile",
    (content) =>
      content.replace(
        "operations.include?('public-group-membership')",
        "false",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing idempotent missing-membership mutation/,
  );
});

test("a missing native tool target is rejected", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      Object.freeze({ output: "windows-arm64.exe", target: "win-arm64" }),\n',
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing native target contract win-arm64/,
  );
});

test("an extra native tool target is rejected", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),\n',
      '      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),\n      Object.freeze({ output: "linux-riscv64", target: "linux-riscv64" }),\n',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing exact native target matrix/,
  );
});

test("native workflows cannot bypass the canonical target plan", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "packagingContract.targets.map((target) =>",
      "[].map((target) =>",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing contract-driven target plan/,
  );
});

test("native execution cannot bypass its fingerprinted invocation plan", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "spawn(invocation.executable, invocation.args",
      'spawn("npx", ["--yes", "@yao-pkg/pkg@latest"]',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing canonical shell-free invocation execution/,
  );
});

test("the complete native command dispatcher remains fingerprinted", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'if (options.command === "package")',
      'if (options.command === "fingerprint")',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing native package command dispatch branch/,
  );
});

test("native executor identity cannot fall back to selected function bodies", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'return readFileSync(NATIVE_EXECUTOR_IMPLEMENTATION_FILE, "utf8");',
      "return packageNativeCli.toString();",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing complete native executor module source/,
  );
});

test("native runtime, packager flags, and workflow actions cannot drift from the contract", () => {
  const contractFile = "scripts/release-packaging-contract.mjs";
  let files = withFileChanged(contractFile, (content) =>
    content
      .replace('embeddedRuntime: "node24"', 'embeddedRuntime: "node26"')
      .replace(
        'flags: Object.freeze(["--no-signature", "--fallback-to-source"])',
        "flags: Object.freeze([])",
      ),
  );
  let errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /missing native embedded runtime contract/);
  assert.match(errors, /missing native packager flag contract/);

  files = withFileChanged(".github/workflows/srn-client.yml", (content) =>
    content.replaceAll(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "actions/setup-node@1111111111111111111111111111111111111111 # v7.0.0",
    ),
  );
  errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /srn-client\.yml: missing contract-bound native action/);
  assert.match(
    errors,
    /unexpected external action outside contract actions\/setup-node@1111111111111111111111111111111111111111/,
  );
});

test("native publishers enforce exact action SHAs and version labels", () => {
  for (const file of [
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-server.yml",
    ".github/workflows/srn-mcp.yml",
    ".github/workflows/srn-home-server.yml",
    ".github/workflows/srn-admin.yml",
  ]) {
    let files = withFileChanged(file, (content) =>
      content.replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "actions/checkout@v7.0.1 # v7.0.1",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /mutable external action reference actions\/checkout@v7\.0\.1/,
    );

    files = withFileChanged(file, (content) =>
      content.replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.0",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /incorrect human version label for actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1; expected v7\.0\.1/,
    );

    files = withFileChanged(file, (content) =>
      content.replace(
        "jobs:\n",
        "jobs:\n  rogue_action:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: evil/example@1111111111111111111111111111111111111111 # v1\n\n",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /unexpected external action outside contract evil\/example@1111111111111111111111111111111111111111/,
    );
  }
});

test("the MCP native publisher preserves its audited locked dependency chain", () => {
  const file = ".github/workflows/srn-mcp.yml";
  for (const [fragment, replacement, expected] of [
    [
      "run: yarn install --immutable",
      "run: npm install --no-package-lock --no-audit --no-fund",
      /forbidden unlocked npm install/,
    ],
    [
      "            --path yarn.lock \\\n",
      "",
      /missing build root lock fingerprint input/,
    ],
    [
      "needs: [impact, audit, build, decide, identity, package, smoke]",
      "needs: [impact, build, decide, identity, package, smoke]",
      /missing release direct audited publication fan-in/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("native release identity and publication remain retry-safe", () => {
  const file = ".github/workflows/srn-client.yml";
  for (const [jobName, nextJobName, fragment, replacement, expected] of [
    [
      "identity",
      "package",
      "needs: [build, decide, impact]",
      "needs: decide",
      /missing native identity dependency on build, decision, and force intent/,
    ],
    [
      "identity",
      "package",
      "EXPECTED_FINGERPRINT: ${{ needs.build.outputs.fingerprint }}",
      "EXPECTED_FINGERPRINT: missing",
      /missing identity deterministic fingerprint input/,
    ],
    [
      "identity",
      "package",
      "fingerprint=${EXPECTED_FINGERPRINT} intent=${intent}",
      "fingerprint=${EXPECTED_FINGERPRINT}",
      /missing tool-commit-fingerprint-intent release marker/,
    ],
    [
      "identity",
      "package",
      "mapfile -t stale_reservations",
      "mapfile -t ignored_reservations",
      /missing stale native draft enumeration/,
    ],
    [
      "identity",
      "package",
      'if [ "${#stale_reservations[@]}" -gt 0 ]; then',
      "if false; then",
      /missing stale native draft fail-closed gate/,
    ],
    [
      "identity",
      "package",
      "published: ${{ steps.identity.outputs.published }}",
      "published_state: ${{ steps.identity.outputs.published }}",
      /missing published reservation output/,
    ],
    [
      "package",
      "release",
      "if: needs.decide.outputs.changed == 'true' && needs.identity.outputs.published != 'true'",
      "if: needs.decide.outputs.changed == 'true'",
      /missing package skip for already-published same-run release/,
    ],
  ]) {
    const files = withJobChanged(file, jobName, nextJobName, (job) =>
      job.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  for (const [fragment, replacement, expected] of [
    [
      "needs: [impact, build, decide, identity, package, smoke]",
      "needs: [build, decide, package]",
      /missing native publication fan-in including force intent/,
    ],
    [
      "if: always() && needs.impact.result == 'success' && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && ((needs.package.result == 'success' && needs.smoke.result == 'success') || (needs.identity.outputs.published == 'true' && needs.package.result == 'skipped' && needs.smoke.result == 'skipped'))",
      "if: needs.decide.outputs.changed == 'true'",
      /missing retry-safe native publication result gate/,
    ],
    [
      'echo "${TOOL}-windows-arm64.exe"',
      "true # asset removed",
      /missing Windows arm64 asset contract/,
    ],
    [
      '.digest | test("^sha256:[0-9a-f]{64}$")',
      ".digest != null",
      /missing remote native asset SHA-256 digest assertion/,
    ],
    [
      'test "$digest" = "sha256:${actual}"',
      'test -n "$digest"',
      /missing remote native asset digest equality/,
    ],
    [
      'gh release upload "$RELEASE_TAG" "${files[@]}" --clobber --repo "$GITHUB_REPOSITORY"',
      'gh release upload "$RELEASE_TAG" "${files[@]}" --repo "$GITHUB_REPOSITORY"',
      /missing retry-safe native asset replacement/,
    ],
    [
      'if [ "$draft" = "false" ]; then',
      "if false; then",
      /missing already-published native recovery branch/,
    ],
    [
      "          verify_directory out\n\n          # No fallible command follows publication.",
      "          true # post-upload verification removed\n\n          # No fallible command follows publication.",
      /missing post-upload native asset verification|native draft publication must follow remote asset hash verification/,
    ],
    [
      "            -f make_latest=false >/dev/null",
      "            >/dev/null",
      /missing native Latest-pointer opt-out|gh api release PATCH.*opt-out/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("native forced reservations are invocation-scoped and retry-stable", () => {
  const file = ".github/workflows/srn-client.yml";
  for (const [fragment, replacement, expected] of [
    [
      "FORCED: ${{ needs.impact.outputs.forced }}",
      "FORCED: 'false'",
      /missing identity force-state input|missing publication force-state input/,
    ],
    [
      "IMPACT_RESULT: ${{ needs.impact.outputs.result_json }}",
      "IMPACT_RESULT: '{}'",
      /missing identity analyzed-impact input|missing publication analyzed-impact input/,
    ],
    [
      "and .forced == $forced",
      "and true",
      /missing identity force-result state assertion|missing publication force-result state assertion/,
    ],
    [
      "(($forced | not) and .forceReason == null)",
      "($forced | not)",
      /missing unforced null-reason assertion|missing publication unforced null-reason assertion/,
    ],
    [
      '(.forceReason | gsub("^\\\\s+|\\\\s+$"; "")) | length > 0',
      "(.forceReason | length > 0)",
      /missing forced nonempty-reason assertion|missing publication forced nonempty-reason assertion/,
    ],
    [
      'intent="forced-${GITHUB_RUN_ID}"',
      'intent="forced"',
      /missing force invocation-scoped intent|missing publication force invocation-scoped intent/,
    ],
    [
      'intent="automatic"',
      'intent="forced-${GITHUB_RUN_ID}"',
      /missing automatic retry intent|missing publication automatic retry intent/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replaceAll(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  const attemptScoped = withFileChanged(file, (content) =>
    content.replaceAll("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"),
  );
  assert.match(
    validateReleaseContract(attemptScoped).join("\n"),
    /native forced identity must stay stable across attempts|native publication force intent must stay stable across attempts/,
  );
});

test("native source, smoke, recovery, and asset-manifest gates remain fail-closed", () => {
  const workflowFile = ".github/workflows/srn-client.yml";
  for (const [fragment, replacement, expected] of [
    [
      "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
      "true # protected source fetch removed",
      /missing protected main source fetch/,
    ],
    [
      "runner: windows-11-arm",
      "runner: windows-2025",
      /missing exact windows-11-arm windows-arm64\.exe native smoke target/,
    ],
    [
      'file "$executable" | grep -E "$FILE_PATTERN"',
      'file "$executable" | grep -E "$FILE_PATTERN" || true',
      /native smoke checks must remain fail-closed/,
    ],
    [
      "environment: release-production",
      "environment: unprotected",
      /missing identity protected production environment|must be scoped exactly to identity and release/,
    ],
    [
      "retention-days: 30",
      "retention-days: 1",
      /every native recovery artifact must be retained for exactly 30 days/,
    ],
    [
      "bind_asset_manifest out",
      "true # asset manifest binding removed",
      /missing pre-mutation native asset binding|asset manifest must bind the validated draft/,
    ],
    [
      "done < \"$expected_assets\" | jq -s 'sort_by(.name)'",
      "done < \"$expected_assets\" | jq -s '.'",
      /missing sorted native asset-manifest entries/,
    ],
    [
      'elif [ "$existing_asset_markers" -ne 1 ]; then',
      "elif false; then",
      /missing exactly one existing native asset-manifest marker/,
    ],
    [
      '-f tag_name="$RELEASE_TAG" -f body="$next_body"',
      '-f body="$next_body"',
      /missing draft tag preservation during native manifest binding/,
    ],
    [
      '| [scan("<!-- srn-release-assets-sha256:[0-9a-f]{64} -->")] | length) == 1)',
      '| [scan("<!-- srn-release-assets-sha256:[0-9a-f]{64} -->")] | length) >= 1)',
      /missing exactly one total native asset-manifest marker/,
    ],
  ]) {
    const files = withFileChanged(workflowFile, (content) =>
      content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  const entrypoint = "cli/srn-client/src/index.ts";
  const files = withFileChanged(entrypoint, (content) =>
    content.replace("--srn-release-self-test", "--unchecked-self-test"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing exact native self-test argument gate/,
  );
});

test("release-policy dependencies install exactly before every parser-backed gate", () => {
  const command =
    "npm ci --prefix scripts --ignore-scripts --no-audit --no-fund";

  let files = withFileChanged(".github/workflows/srn-client.yml", (content) =>
    content.replace(`${command}\n`, ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /expected exactly 2 release-policy dependency install\(s\), found 1|dependencies must install before contract validation/,
  );

  files = withJobChanged(
    ".github/workflows/srn-client.yml",
    "build",
    "decide",
    (job) => job.replace(`${command}\n`, ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /expected exactly 2 release-policy dependency install\(s\), found 1|Install release policy dependencies.*must be immediately followed/,
  );

  files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace(
      `      - name: Install release policy dependencies\n        run: ${command}\n\n      - name: Validate release packaging contract`,
      `      - name: Validate release packaging contract\n        run: node scripts/validate-release-contract.mjs\n\n      - name: Install release policy dependencies\n        run: ${command}`,
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /dependencies must install before contract validation and impact analysis|integrity step 'Install release policy dependencies' must be immediately followed/,
  );

  for (const file of [
    ".github/workflows/release-contract.yml",
    ".github/workflows/ci.yml",
  ]) {
    files = withFileChanged(file, (content) =>
      content.replace(command, "true"),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /must install release-policy dependencies exactly once|dependencies must install before/,
    );
  }

  files = withFileChanged("package.json", (content) =>
    content.replace(
      "yarn release:policy:install && yarn release:impact:run",
      "node scripts/analyze-release-impact.mjs",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /release:impact must use the explicit pinned release-policy dependency boundary/,
  );

  files = withFileChanged("scripts/package.json", (content) =>
    content.replace('"@babel/parser": "7.29.7"', '"@babel/parser": "^7.29.7"'),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /must contain only exact @babel\/parser@7\.29\.7/,
  );

  files = withFileChanged(
    "scripts/native-cli-release.mjs",
    (content) =>
      `${content}\n// process.binding must never load a private parser\n`,
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /private Node parser access is forbidden/,
  );

  files = withFileChanged(
    "scripts/analyze-release-impact.test.mjs",
    (content) =>
      content.replace(
        "legacy semantic baselines migrate with conservative full fanout",
        "legacy migration is untested",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing one-time legacy native fanout regression/,
  );
});

test("all publishers self-validate the release contract before impact analysis", () => {
  for (const file of [
    ".github/workflows/srn-admin.yml",
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-desktop.yml",
    ".github/workflows/srn-home-server.yml",
    ".github/workflows/srn-mcp.yml",
    ".github/workflows/srn-mobile.yml",
    ".github/workflows/srn-openclaw.yml",
    ".github/workflows/srn-server.yml",
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(
        "        run: node scripts/validate-release-contract.mjs\n",
        "",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      new RegExp(
        `${path.basename(file).replace(".", "\\.")}: missing in-chain packaging contract validation`,
      ),
    );
  }
});

test("publisher contract validation cannot move behind impact analysis", () => {
  const file = ".github/workflows/srn-mcp.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "      - name: Validate release packaging contract\n        run: node scripts/validate-release-contract.mjs\n\n      - id: impact",
        "      - id: impact",
      )
      .replace(
        '          } >> "$GITHUB_STEP_SUMMARY"\n',
        '          } >> "$GITHUB_STEP_SUMMARY"\n\n      - name: Validate release packaging contract\n        run: node scripts/validate-release-contract.mjs\n',
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mcp\.yml: packaging contract validation must run before release-impact analysis/,
  );
});

test("a missing OpenClaw native smoke target is rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "          - target: windows-arm64\n            runner: windows-11-arm\n            architecture: arm64\n",
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /expected one windows-arm64 smoke target on windows-11-arm/,
  );
});

test("fake native OpenClaw archives are rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replaceAll("-node-any.tgz", "-windows-x64.zip"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /platform-neutral OpenClaw must not publish fake native archives/,
  );
});

test("mutable OpenClaw action references are rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "actions/checkout@v7",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /mutable external action reference actions\/checkout@v7/,
  );
});

test("OpenClaw action SHAs, labels, and inventory remain exact", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  let files = withFileChanged(file, (content) =>
    content.replace(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
      "actions/checkout@1111111111111111111111111111111111111111 # v7.0.0",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /unexpected external action outside contract actions\/checkout@1111111111111111111111111111111111111111/,
  );

  files = withFileChanged(file, (content) =>
    content.replace(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.1",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /incorrect human version label for actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0; expected v7\.0\.0/,
  );

  files = withFileChanged(file, (content) =>
    content.replace(
      "jobs:\n",
      "jobs:\n  rogue_action:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: evil/example@1111111111111111111111111111111111111111 # v1\n\n",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /unexpected external action outside contract evil\/example@1111111111111111111111111111111111111111/,
  );
});

test("the real OpenClaw live E2E remains release-blocking", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "yarn workspace @standard-red-notes/openclaw test:e2e",
      "yarn workspace @standard-red-notes/openclaw build",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing real OpenClaw live MCP E2E gate/,
  );
});

test("every OpenClaw runtime dependency must stay bundled", () => {
  const file = "openclaw/package.json";
  const files = withFileChanged(file, (content) => {
    const packageJson = JSON.parse(content);
    packageJson.bundleDependencies = packageJson.bundleDependencies.filter(
      (dependency) => dependency !== "zod",
    );
    return JSON.stringify(packageJson);
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /every runtime dependency must be bundled/,
  );
});

function withOpenClawPackage(update) {
  return withFileChanged("openclaw/package.json", (content) => {
    const packageJson = JSON.parse(content);
    update(packageJson);
    return JSON.stringify(packageJson);
  });
}

test("the OpenClaw manifest stays in Yarn's install-idempotent form", () => {
  const packageJson = JSON.parse(baseline.get("openclaw/package.json"));
  assert.equal(Object.hasOwn(packageJson, "private"), false);
  assert.equal(packageJson.bin, "dist/index.js");
  assert.deepEqual(validateReleaseContract(baseline), []);
});

test("behaviorally equivalent non-canonical OpenClaw fields are rejected", () => {
  let files = withOpenClawPackage((packageJson) => {
    packageJson.private = false;
  });
  assert.match(
    validateReleaseContract(files).join("\n"),
    /must omit the default private field/,
  );

  files = withOpenClawPackage((packageJson) => {
    packageJson.bin = { openclaw: "dist/index.js" };
  });
  assert.match(
    validateReleaseContract(files).join("\n"),
    /using Yarn's canonical string form/,
  );
});

test("a private OpenClaw release package is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.private = true;
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release package must not be private/,
  );
});

test("a missing OpenClaw executable is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    delete packageJson.bin;
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

test("an OpenClaw executable pointing at the wrong entrypoint is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.bin = "dist/cli.js";
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

test("an OpenClaw executable published under another name is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.bin = { claw: "dist/index.js" };
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

// OpenClaw auto-releases on every push to main, versioned and tagged like every
// other srn-* component: rolling `YY.N` under a namespaced `srn-openclaw-v*`
// tag. The previous scheme released only from a pushed tag.
const openClawWorkflowFile = ".github/workflows/srn-openclaw.yml";

test("dropping the OpenClaw auto-release trigger is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace("    branches: [main]\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw auto-release trigger on main/,
  );
});

test("dropping the OpenClaw workspace trigger path is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace('      - "openclaw/**"\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw workspace release trigger path/,
  );
});

test("an unnamespaced OpenClaw release tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace('tag="${TOOL}-v${version}"', 'tag="v${version}"'),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: OpenClaw must not publish an unnamespaced v\* tag/,
  );
});

test("dropping the namespaced OpenClaw tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'tag="${TOOL}-v${version}"',
      'tag="srn-openclaw-${version}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing namespaced OpenClaw release tag/,
  );
});

test("reverting OpenClaw to a tag-parsed version is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'version="${YY}.${next}"',
      'version="$(date -u +%y).${GITHUB_RUN_NUMBER}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing rolling YY\.N OpenClaw version/,
  );
});

test("OpenClaw rolling versions cannot reuse an explicit SemVer package identity", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '            while git show-ref --verify --quiet "refs/tags/${TOOL}-v${YY}.${next}.0"; do\n',
      "            while false; do\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing explicit SemVer package-version reservation/,
  );
});

// release-config.mjs only accepts `srn-openclaw-v<semver>`, and `26.1` is not
// semver, so the packaged artifact must carry `26.1.0`.
test("packaging OpenClaw under the non-semver release version is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replaceAll(
      '            package_version="${version}.0"\n',
      '            package_version="${version}"\n',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing semver package version for packaging/,
  );
});

test("packaging OpenClaw with the release identity instead of the semver tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '--tag "${{ needs.context.outputs.package_tag }}"',
      '--tag "${{ needs.context.outputs.tag }}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing semver packaging tag/,
  );
});

// Without the stamp the packaged tarball would ship openclaw/package.json's
// placeholder development version, and package-release.mjs's own tag/manifest
// equality assertion would no longer be satisfiable by the rolling version.
test("dropping the OpenClaw release version stamp is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "            manifest.version = process.env.PACKAGE_VERSION;\n",
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing release version stamped into the packaged manifest/,
  );
});

test("dropping the explicit-tag version assertion is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'if [ "${version}" != "${declared_version}" ]; then',
      "if false; then",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing explicit-tag version assertion against openclaw\/package\.json/,
  );
});

test("OpenClaw explicit tags cannot be combined with forced rolling intent", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'if [ "$FORCED" = "true" ]; then\n              echo "force_release cannot be combined with an explicit OpenClaw tag." >&2',
      'if false; then\n              echo "force accepted with an explicit tag" >&2',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing force and explicit-tag mutual exclusion/,
  );
});

test("a non-srn-* OpenClaw release title is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '-f name="${TOOL} ${VERSION}"',
      '-f name="OpenClaw ${VERSION}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing srn-\* OpenClaw release title convention/,
  );
});

test("OpenClaw reservations are invocation-stable, fingerprint-bound, and stale-draft safe", () => {
  for (const [fragment, replacement, expected] of [
    [
      'intent="forced-${GITHUB_RUN_ID}"',
      'intent="forced-${GITHUB_RUN_ATTEMPT}"',
      /forced OpenClaw identity must remain stable across rerun attempts/,
    ],
    [
      "fingerprint=${EXPECTED_FINGERPRINT} intent=${INTENT}",
      "intent=${INTENT}",
      /missing OpenClaw commit-fingerprint-intent marker|missing publication OpenClaw commit-fingerprint-intent marker/,
    ],
    [
      "mapfile -t stale_reservations",
      "mapfile -t ignored_reservations",
      /missing stale OpenClaw draft enumeration|missing fingerprint-mismatched OpenClaw draft enumeration/,
    ],
    [
      "Reconcile or delete the stale drafts explicitly, then rerun.",
      "continue past stale drafts",
      /missing stale OpenClaw draft recovery instruction/,
    ],
    [
      "mapfile -t exact_reservations",
      "mapfile -t ignored_exact_reservations",
      /missing live exact OpenClaw reservation recovery/,
    ],
    [
      'elif [ "${#exact_reservations[@]}" -eq 1 ]; then',
      "elif false; then",
      /missing failed-job OpenClaw reservation adoption/,
    ],
    ["-F draft=true", "-F draft=false", /missing OpenClaw draft-only creation/],
    [
      'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
      'gh release create "$TAG"',
      /missing draft-only OpenClaw reservation|OpenClaw identity must reserve a draft through the exact release API/,
    ],
  ]) {
    const files = withFileChanged(openClawWorkflowFile, (content) =>
      content.replaceAll(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("OpenClaw publication verifies exact attested assets before finalizing its draft", () => {
  for (const [fragment, replacement, expected] of [
    [
      "needs: [context, package, decide, identity, attest]",
      "needs: [context, package, decide, attest]",
      /missing reserved and attested OpenClaw release fan-in/,
    ],
    [
      "if: always() && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && (needs.attest.result == 'success' || (needs.identity.outputs.published == 'true' && needs.attest.result == 'skipped'))",
      "if: needs.decide.outputs.changed == 'true'",
      /missing retry-safe OpenClaw publication result gate/,
    ],
    [
      'echo "${TOOL}-${PACKAGE_VERSION}-node-any.provenance.sigstore.json"',
      "true # provenance omitted",
      /missing exact OpenClaw provenance asset identity/,
    ],
    [
      'test "$digest" = "sha256:${actual}"',
      'test -n "$digest"',
      /missing remote OpenClaw asset digest equality/,
    ],
    [
      'gh release upload "$TAG" "${files[@]}" --clobber --repo "$GITHUB_REPOSITORY"',
      'gh release upload "$TAG" "${files[@]}" --repo "$GITHUB_REPOSITORY"',
      /missing retry-safe OpenClaw asset replacement/,
    ],
    [
      'verify_remote out "$release"',
      "true # remote verification removed",
      /OpenClaw publication must validate identity, local assets, upload, verify remote digests, then publish/,
    ],
    [
      "<!-- srn-release-assets sha256=${asset_plan_sha} -->",
      "<!-- unbound-assets -->",
      /missing exact published OpenClaw asset-plan marker/,
    ],
    [
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      'gh release create "$TAG"',
      /missing final OpenClaw draft publication|OpenClaw publication must reuse its reserved draft/,
    ],
  ]) {
    const files = withFileChanged(openClawWorkflowFile, (content) =>
      fragment.includes("srn-release-assets")
        ? content.replaceAll(fragment, replacement)
        : content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

// Signing and publishing are separate jobs because permissions are per-job.
// Held together, `gh release create` returned "HTTP 403: Resource not
// accessible by integration" from POST /releases even though the runner
// reported `Contents: write`, while every other srn-* publisher -- carrying
// `contents: write` and nothing else -- publishes fine.
test("removing the OpenClaw attestation job is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(/\r?\n  attest:\r?\n/, "\n  Removed-attest:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw attestation job/,
  );
});

test("an attestation scope on the OpenClaw publish job is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "    name: Verify and publish exact GitHub release\n    needs: [context, package, decide, identity, attest]\n",
      "    name: Verify and publish exact GitHub release\n    permissions:\n      attestations: write\n    needs: [context, package, decide, identity, attest]\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /publish job must not request 'attestations: write'/,
  );
});

test("dropping the attested payload from the OpenClaw release fan-in is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "needs: [context, package, decide, identity, attest]",
      "needs: [context, package, identity, attest]",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing reserved and attested OpenClaw release fan-in|release publication does not depend on decide/,
  );
});

test("a best-effort attested payload handoff is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "          name: srn-openclaw-attested-package\n          path: out/*\n          if-no-files-found: error\n",
      "          name: srn-openclaw-attested-package\n          path: out/*\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing required attested payload upload/,
  );
});

test("OpenClaw provenance action identity is bound in workflow and fingerprint contract", () => {
  let files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373",
      "actions/attest-build-provenance@1111111111111111111111111111111111111111",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing contract-bound provenance action/,
  );

  files = withFileChanged("scripts/release-packaging-contract.mjs", (content) =>
    content.replace(
      'attestBuildProvenance: "0f67c3f4856b2e3261c31976d6725780e5e4c373"',
      'attestBuildProvenance: "mutable-tag"',
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing fingerprinted OpenClaw provenance action/,
  );
});

test("OpenClaw provenance subjects and bundle filename cannot drift", () => {
  let files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replaceAll(
      "out/srn-openclaw-${{ needs.context.outputs.package_version }}-node-any.manifest.json",
      "out/unattested-manifest.json",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing contract-bound provenance subject/,
  );

  files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "srn-openclaw-${{ needs.context.outputs.package_version }}-node-any.provenance.sigstore.json",
      "unbound-provenance.json",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing contract-bound provenance bundle filename/,
  );
});

test("OpenClaw provenance verification is bound to repository, source, and signer", () => {
  for (const [fragment, replacement, expected] of [
    [
      '--repo "$GITHUB_REPOSITORY"',
      '--repo "untrusted/repository"',
      /missing exact OpenClaw repository binding/,
    ],
    [
      '--source-digest "${{ needs.context.outputs.source_sha }}"',
      '--source-digest "0000000000000000000000000000000000000000"',
      /missing exact OpenClaw source-digest binding/,
    ],
    [
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/srn-openclaw.yml"',
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/untrusted.yml"',
      /missing exact OpenClaw signer-workflow binding/,
    ],
  ]) {
    const files = withFileChanged(openClawWorkflowFile, (content) =>
      content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("OpenClaw provenance predicate remains fingerprinted", () => {
  const files = withFileChanged(
    "scripts/release-packaging-contract.mjs",
    (content) =>
      content.replace(
        'predicate: "slsa-build-provenance"',
        'predicate: "custom-provenance"',
      ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing fingerprinted OpenClaw provenance predicate/,
  );
});

// Yarn's node-modules linker writes node_modules/.bin/* as symlinks on Linux,
// which the release payload walk rejected outright -- no OpenClaw release could
// be packaged at all. The allowance that unblocks it must stay scoped to
// `.bin`, because a walk that skips symlinks anywhere can step over a link to a
// native addon and silently defeat the platform-neutrality guard.
const openClawPackagerFile = "openclaw/scripts/package-release.mjs";

test("dropping the bin-shim symlink allowance is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      '    } else if (entry.isSymbolicLink() && path.basename(directory) === ".bin") {\n',
      "    } else if (false) {\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing bin-shim-only symlink allowance/,
  );
});

test("broadening the symlink allowance beyond .bin is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      'entry.isSymbolicLink() && path.basename(directory) === ".bin"',
      "entry.isSymbolicLink()",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: 1 symlink allowance\(s\) but 0 scoped to \.bin/,
  );
});

test("a second unscoped symlink allowance is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "    } else if (entry.isSymbolicLink() &&",
      "    } else if (entry.isSymbolicLink()) {\n      continue;\n    } else if (entry.isSymbolicLink() &&",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: 2 symlink allowance\(s\) but 1 scoped to \.bin/,
  );
});

// openclaw is a root yarn workspace, so an install collapses its `bin` map to
// the bare string form and drops `private: false`. This validator already
// accepts that shape (cb979521); the release scripts must accept exactly the
// same one, or a manifest that passes the contract would fail the release.
const openClawVerifierFile = "openclaw/scripts/verify-release.mjs";

test("a packager that rejects the Yarn-normalized bin shape is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      'const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\\//, "");\n  return unscopedName === "openclaw" ? bin : undefined;',
      "return undefined;",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing bin string form scoped to the openclaw executable/,
  );
});

test("a verifier that rejects the Yarn-normalized bin shape is rejected", () => {
  const files = withFileChanged(openClawVerifierFile, (content) =>
    content.replace(
      'const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\\//, "");\n  return unscopedName === "openclaw" ? bin : undefined;',
      "return undefined;",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /verify-release\.mjs: missing bin string form scoped to the openclaw executable/,
  );
});

test("dropping the packaged bin target assertion is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "package bin.openclaw must point to dist/index.js",
      "package bin is fine",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing packaged bin target assertion/,
  );
});

test("dropping the installed bin target assertion is rejected", () => {
  const files = withFileChanged(openClawVerifierFile, (content) =>
    content.replace('binTarget(packageJson) !== "dist/index.js"', "false"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /verify-release\.mjs: missing installed bin target assertion/,
  );
});

test("the native addon rejection survives the symlink allowance", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "platform-neutral package cannot contain native addons",
      "package contains native addons",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing native addon rejection/,
  );
});

test("standalone desktop toolchains, targets, and artifacts are exact", () => {
  const file = "app/.github/workflows/desktop.release.reuse.yml";
  for (const [fragment, replacement, expected] of [
    [
      "runs-on: ubuntu-24.04-arm",
      "runs-on: ubuntu-latest",
      /missing Linux-AppImage-ARM64 contract-bound runner|standalone desktop runner matrix/,
    ],
    [
      "python-version: '3.10'",
      "python-version: '3.11'",
      /expected 7 standalone Python 3\.10 setup legs/,
    ],
    [
      "yarn run electron-builder --mac dmg zip --x64 --arm64 --publish=never --c.extraMetadata.version=${{ env.APP_VERSION }}",
      "true # combined macOS builder removed",
      /missing Mac contract-bound builder invocation|standalone desktop builder set must exactly match/,
    ],
    [
      "name: dist-linux-x64",
      "name: dist-linux-unbound",
      /missing Linux-AppImage-X64 artifact name|upload paths must exactly match/,
    ],
    [
      "packages/desktop/dist/*.AppImage",
      "packages/desktop/dist/*.tar.gz",
      /missing Linux-AppImage-X64 artifact glob/,
    ],
    [
      'review-tools.snap-review "${snaps[0]}"',
      "true # Snap validation removed",
      /missing Linux-Snap contract-bound validation command/,
    ],
    [
      'snapcraft upload "$snap_file" --release stable,candidate,beta,edge',
      "true # Snap publication removed",
      /missing contract-bound standalone desktop publication command/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  let files = withJobChanged(
    file,
    "Linux-AppImage-X64",
    "Linux-AppImage-ARM64",
    (job) => job.replace("          if-no-files-found: error\n", ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Linux-AppImage-X64 required artifact upload/,
  );

  files = withFileChanged(file, (content) =>
    content.replace(
      "  PublishGitHub:\n",
      "  Unexpected-Package:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  PublishGitHub:\n",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /standalone desktop job set must exactly match the fingerprint contract/,
  );
});

test("standalone desktop publication stays least-privilege and fail-closed", () => {
  const file = "app/.github/workflows/desktop.release.reuse.yml";
  for (const [fragment, replacement, expected] of [
    [
      "permissions:\n  contents: read",
      "permissions:\n  contents: write",
      /missing read-only reusable desktop permissions/,
    ],
    [
      "group: desktop-release-${{ inputs.channel }}",
      "group: desktop-release",
      /missing channel-scoped non-cancelling reusable desktop concurrency/,
    ],
    [
      "  FanIn:\n    runs-on: ubuntu-latest\n",
      "  FanIn:\n    if: always()\n    runs-on: ubuntu-latest\n",
      /Publish must not bypass failed or skipped platform dependencies/,
    ],
    [
      ".target_commitish == $sha",
      '.target_commitish == "main"',
      /missing same-commit reusable desktop release target assertion/,
    ],
    [
      "SNAPCRAFT_STORE_CREDENTIALS: ${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}",
      "CI_PAT_TOKEN: ${{ secrets.CI_PAT_TOKEN }}",
      /broad CI PAT is forbidden for reusable desktop release/,
    ],
  ]) {
    const files = withFileChanged(file, (content) =>
      fragment === ".target_commitish == $sha"
        ? content.replaceAll(fragment, replacement)
        : content.replace(fragment, replacement),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }
});

test("desktop production calls only the same-commit reusable workflow", () => {
  const file = "app/.github/workflows/desktop.release.prod.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "uses: ./.github/workflows/desktop.release.reuse.yml",
      "uses: standardnotes/app/.github/workflows/desktop.release.reuse.yml@main",
    ),
  );
  const errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /missing same-commit reusable desktop workflow caller/);
  assert.match(
    errors,
    /desktop production must not call a remote or mutable reusable workflow/,
  );
});

test("desktop action inventories reject SHA, label, and owner drift", () => {
  for (const file of [
    ".github/workflows/srn-desktop.yml",
    "app/.github/workflows/desktop.release.reuse.yml",
  ]) {
    let files = withFileChanged(file, (content) =>
      content.replace(
        "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0",
        "actions/setup-python@1111111111111111111111111111111111111111 # v6.3.0",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /unexpected external action outside contract actions\/setup-python@1111111111111111111111111111111111111111/,
    );

    files = withFileChanged(file, (content) =>
      content.replace(
        "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0",
        "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.2.0",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /incorrect human version label for actions\/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1; expected v6\.3\.0/,
    );
  }
});

test("a missing app Windows release job is rejected", () => {
  const file = "app/.github/workflows/desktop.release.reuse.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(/\r?\n  Windows:\r?\n/, "\n  Removed-Windows:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /desktop\.release\.reuse\.yml: missing Windows job/,
  );
});

test("desktop updater metadata, architecture, recovery, and environment guards cannot drift", () => {
  let files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace("=dmg-arm64", "=dmg-x64"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing macOS DMG ARM64 architecture verification/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace("dist/latest*.yml", "dist/*.yml"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing updater-only desktop metadata inventory/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace("metadata_files=()", "mapfile -t metadata_files=()"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /must not use Bash-4-only mapfile/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace(
      "for path in *; do",
      "find . -type f -printf '%f\\n'\n            for path in *; do",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /must not use GNU-only find -printf/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace("checksum=(shasum -a 256)", "checksum=(sha256sum)"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing macOS desktop checksum fallback/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replaceAll("linux-x86_64.AppImage", "linux-x64.AppImage"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing electron-builder Linux x64 AppImage filename|missing electron-builder Linux x64 AppImage architecture binding/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replaceAll("linux-amd64.deb", "linux-x64.deb"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing electron-builder Linux x64 Debian filename|missing electron-builder Linux x64 Debian architecture binding/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace(
      "ruby app/scripts/verify-desktop-updater-metadata.rb",
      "ruby -c app/scripts/verify-desktop-updater-metadata.rb",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /root fan-in must verify exactly four updater authorities/,
  );

  files = withJobChanged(
    "app/.github/workflows/desktop.release.reuse.yml",
    "Linux-Snap",
    "FanIn",
    (job) =>
      job.replace("environment: release-production", "environment: test"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Linux-Snap protected production environment|must be scoped exactly to .*Snap build/,
  );

  files = withFileChanged(
    "app/.github/workflows/desktop.release.reuse.yml",
    (content) => content.replace("retention-days: 30", "retention-days: 1"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /every standalone desktop recovery artifact must be retained for exactly 30 days/,
  );

  files = withFileChanged(
    "app/.github/workflows/desktop.release.prod.yml",
    (content) =>
      content.replace(
        'test "$GITHUB_SHA" = "$protected_sha"',
        "true # protected commit check removed",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing exact desktop recovery source commit/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.rb",
    (content) => content.replace("declared == actual", "declared != actual"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing exact updater SHA-512 equality/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.rb",
    (content) =>
      content.replace(
        "DMG_EXECUTABLE_SELECTOR = '-ir!*.app/Contents/MacOS/*'",
        "DMG_EXECUTABLE_SELECTOR = '*'",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing selective macOS DMG executable extraction/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.rb",
    (content) => content.replace(".to_s.tr('\\\\', '/')", ".to_s"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Windows archive path separator normalization/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.rb",
    (content) =>
      content.replace("File.basename(relative).match?", "relative.match?"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing all-path Windows payload discovery/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.rb",
    (content) =>
      content.replace("optional_magic == 0x20b", "optional_magic != 0x20b"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Windows PE32\+ optional-header assertion/,
  );

  files = withFileChanged(
    "app/scripts/verify-desktop-updater-metadata.test.rb",
    (content) =>
      content.replace(
        "test_rejects_wrong_architecture_for_every_supported_format",
        "test_skips_wrong_architecture",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing all-format updater architecture rejection test/,
  );
});

test("desktop Linux packages prune every foreign native prebuild before packaging", () => {
  let files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace("target_arch: x64", "target_arch: arm64"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing Linux x64 native prebuild target/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace(" --node-modules app/dist/node_modules", ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing both Linux packaged dependency graphs pruned/,
  );

  files = withFileChanged(".github/workflows/srn-desktop.yml", (content) =>
    content.replace(
      "      - name: electron-builder",
      "      - run: echo intervening-step\n\n      - name: electron-builder",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /integrity step 'Prune foreign Linux native prebuilds' must be immediately followed by 'electron-builder'/,
  );

  files = withFileChanged(
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.js",
    (content) =>
      content.replace(
        "expected: `cbor-extract-linux-${architecture}`",
        "expected: 'cbor-extract-linux-any'",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing target-specific cbor-extract prebuild/,
  );

  files = withFileChanged(
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.js",
    (content) => content.replace("force: false", "force: true"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing fail-closed foreign prebuild removal/,
  );

  files = withFileChanged(
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.test.js",
    (content) =>
      content.replace(
        "arm64 pruning keeps only arm64 Linux native prebuilds in both packaged graphs",
        "arm64 pruning is skipped",
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing dual-graph arm64 native prebuild pruning test/,
  );
});

test("OpenClaw release sources, recovery artifacts, and privileged jobs stay protected", () => {
  let files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace(
      'git merge-base --is-ancestor "$tagged_sha" "$protected_sha"',
      "true # ancestry removed",
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing OpenClaw tag ancestry from protected main/,
  );

  files = withJobChanged(
    ".github/workflows/srn-openclaw.yml",
    "attest",
    "release",
    (job) =>
      job.replace("environment: release-production", "environment: test"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing attest protected production environment|must be scoped exactly to identity, attestation, and release/,
  );

  files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace("retention-days: 30", "retention-days: 1"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /every OpenClaw recovery artifact must be retained for exactly 30 days/,
  );

  files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace(
      '[[ "$tag" =~ ^srn-openclaw-v[0-9A-Za-z.+-]+$ ]]',
      '[[ "$tag" =~ ^srn-openclaw-v[0-9A-Za-z.-]+$ ]]',
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing build-metadata-capable OpenClaw source tag authorization/,
  );
});

test("OpenClaw build metadata remains accepted by the authoritative tag gates", () => {
  let files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace(
      'if [[ ! "${tag}" =~ ^srn-openclaw-v[0-9A-Za-z.+-]+$ ]]; then',
      'if [[ ! "${tag}" =~ ^srn-openclaw-v[0-9A-Za-z.-]+$ ]]; then',
    ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing build-metadata-capable authoritative OpenClaw tag gate/,
  );

  files = withFileChanged("openclaw/scripts/release-config.mjs", (content) =>
    content.replace("(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?", ""),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing full SemVer build-metadata release-tag grammar/,
  );
});

test("OpenClaw retry recovery uses the central full SemVer parser", () => {
  const files = withFileChanged(
    ".github/workflows/srn-openclaw.yml",
    (content) =>
      content.replace(
        'elif package_version="$(parse_explicit_version "${tag}")"; then',
        'elif [[ "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then',
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing recovered explicit OpenClaw tag parsing/,
  );
});

// The canonical root desktop publisher intentionally carries no Snap target.
// Snap is isolated to the audited manual-only embedded recovery workflow; the
// root OS/arch installer matrix must still gate GitHub publication completely.
const desktopWorkflowFile = ".github/workflows/srn-desktop.yml";
const desktopPackageFile = "app/packages/desktop/package.json";

test("desktop runtime fingerprinting declares its ASAR tool directly", () => {
  const files = withFileChanged(desktopPackageFile, (content) =>
    content.replace('    "@electron/asar": "4.3.1",\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing exact direct @electron\/asar 4\.3\.1 devDependency/,
  );
});

test("desktop packaging disables electron-builder's universal Windows installer", () => {
  const files = withFileChanged(desktopPackageFile, (content) =>
    content.replace(
      '      "buildUniversalInstaller": false,',
      '      "buildUniversalInstaller": true,',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing disabled universal Windows installer/,
  );
});

test("the desktop pipeline carries no Snap target", () => {
  const workflow = baseline.get(desktopWorkflowFile);

  // Prose about why Snap went away is fine; a Snap job, a snapcraft install or
  // a snap electron-builder invocation is not.
  assert.doesNotMatch(workflow, /\r?\n {2}snap:\r?\n/);
  assert.doesNotMatch(
    workflow,
    /snap install snapcraft|--linux snap|srn-desktop-linux-snap/,
  );
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.deepEqual(validateReleaseContract(baseline), []);
});

test("a removed desktop build matrix is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(/\r?\n  build:\r?\n/, "\n  Removed-build:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing desktop build matrix/,
  );
});

test("a partial desktop build matrix is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace("      fail-fast: false\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing complete desktop build matrix/,
  );
});

test("a best-effort desktop installer upload is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace("          if-no-files-found: error\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing required desktop installer upload/,
  );
});

test("a best-effort desktop build leg is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "    runs-on: ${{ matrix.os }}\n",
      "    runs-on: ${{ matrix.os }}\n    continue-on-error: true\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /no desktop release leg may be best-effort/,
  );
});

test("superseded empty desktop draft cleanup remains fail-closed", () => {
  const ownershipAwareSnapshot = `snapshot_filter='{id,tag_name,name,target_commitish,draft,prerelease,published_at_present:has("published_at"),published_at,immutable,author:{login:.author.login,type:.author.type,id:.author.id},body:(.body // ""),asset_ids:([.assets[]?.id] | sort)}'`;
  const snapshotSchemaError =
    /missing pinned stale desktop snapshot schema|must define exactly one pinned ownership-aware snapshot schema/;
  for (const [before, after, expected] of [
    [
      'if [ "${#stale_reservations[@]}" -gt 1 ]; then',
      'if [ "${#stale_reservations[@]}" -gt 99 ]; then',
      /missing ambiguous stale desktop draft rejection/,
    ],
    [
      'elif [ "${#stale_reservations[@]}" -eq 1 ]; then',
      'elif [ "${#stale_reservations[@]}" -eq 0 ]; then',
      /missing single stale desktop draft reconciliation/,
    ],
    [
      'stale_marker="<!-- srn-release-reservation tool=srn-desktop commit=${stale_sha} intent=automatic -->"',
      'stale_marker="<!-- srn-release-reservation tool=srn-desktop commit=${stale_sha} intent=forced-${GITHUB_RUN_ID} -->"',
      /missing recognized automatic stale desktop marker/,
    ],
    [
      '$release.tag_name | test("^srn-desktop-v[0-9]{2}\\\\.[1-9][0-9]*$")',
      '$release.tag_name | test("^srn-desktop-v")',
      /missing stale desktop tag format validation/,
    ],
    [
      '$release.name == ("srn-desktop " + ($release.tag_name | sub("^srn-desktop-v"; "")))',
      '$release.name | startswith("srn-desktop")',
      /missing stale desktop title binding/,
    ],
    [
      '$release.target_commitish | test("^[0-9a-f]{40}$")',
      "$release.target_commitish | length > 0",
      /missing stale desktop source commit validation/,
    ],
    [
      "$release.draft == true",
      "$release.draft == false",
      /missing stale desktop draft-state guard/,
    ],
    [
      "$release.prerelease == false",
      "$release.prerelease == true",
      /missing stale desktop prerelease guard/,
    ],
    [
      '$release.author.login == "github-actions[bot]"',
      '$release.author.login == "release-operator"',
      /missing canonical stale desktop author login guard/,
    ],
    [
      '$release.author.type == "Bot"',
      '$release.author.type == "User"',
      /missing canonical stale desktop author type guard/,
    ],
    [
      "$release.author.id == 41898282",
      "$release.author.id > 0",
      /missing canonical stale desktop author identity guard/,
    ],
    [
      '$release | has("published_at")',
      '$release | has("created_at")',
      /missing stale desktop publication-field presence guard/,
    ],
    [
      "$release.published_at == null",
      "$release.published_at != null",
      /missing unpublished stale desktop guard/,
    ],
    [
      "$release.immutable == false",
      "$release.immutable != true",
      /missing mutable stale desktop guard/,
    ],
    [
      "($release.assets | length) == 0",
      "($release.assets | length) >= 0",
      /missing empty stale desktop draft guard/,
    ],
    [
      '($release.body // "") | startswith($expected_marker)',
      '($release.body // "") | contains($expected_marker)',
      /missing exact stale desktop marker guard/,
    ],
    [
      'scan("<!-- srn-release-reservation tool=srn-desktop ")',
      'scan("<!-- any-release-reservation ")',
      /missing single stale desktop marker guard/,
    ],
    [
      `jq --arg tag "$stale_tag" '[.[] | select(.tag_name == $tag)] | length'`,
      `jq --arg tag "$stale_tag" '[.[] | select(.tag_name != $tag)] | length'`,
      /stale desktop tag uniqueness must be proven/,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace(
        'published_at_present:has("published_at"),',
        "",
      ),
      snapshotSchemaError,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace(
        "login:.author.login",
        "login:.author.name",
      ),
      snapshotSchemaError,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace("type:.author.type", "type:.author.login"),
      snapshotSchemaError,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace("id:.author.id", "id:.author.node_id"),
      snapshotSchemaError,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace(",published_at,immutable", ",immutable"),
      snapshotSchemaError,
    ],
    [
      ownershipAwareSnapshot,
      ownershipAwareSnapshot.replace(",immutable,author", ",author"),
      snapshotSchemaError,
    ],
    [
      'live="$(gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}")"',
      'live="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${stale_tag}")"',
      /missing immutable-ID stale desktop refetch|must perform exactly two immutable-ID release reads/,
    ],
    [
      'test "$live_snapshot" = "$expected_snapshot"',
      'test "$live_snapshot" != "$expected_snapshot"',
      /missing immutable-ID stale desktop mutation guard/,
    ],
    [
      'test "$refreshed_snapshot" = "$expected_snapshot"',
      'test "$refreshed_snapshot" != "$expected_snapshot"',
      /missing complete stale desktop inventory mutation guard/,
    ],
    [
      'git show-ref --verify --quiet "refs/tags/${stale_tag}"',
      'git show-ref --verify --quiet "refs/tags/${stale_tag}-ignored"',
      /missing stale desktop Git tag guard/,
    ],
    [
      'final_live="$(gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}")"',
      'final_live="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${stale_tag}")"',
      /missing final immutable-ID stale desktop refetch|must perform exactly two immutable-ID release reads/,
    ],
    [
      'final_snapshot="$(jq -c "$snapshot_filter" <<< "$final_live")"',
      'final_snapshot="$(jq -c "." <<< "$final_live")"',
      /missing final stale desktop snapshot projection|stale desktop final deletion sequence must remain/,
    ],
    [
      'test "$final_snapshot" = "$expected_snapshot"',
      'test "$final_snapshot" != "$expected_snapshot"',
      /missing final pre-delete stale desktop mutation guard/,
    ],
    [
      'gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${release_id}"',
      'gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/tags/${stale_tag}"',
      /missing exact superseded desktop draft deletion|must perform exactly one immutable-ID release deletion/,
    ],
    [
      "mapfile -t stale_after_reconciliation",
      "mapfile -t ignored_stale_after_reconciliation",
      /missing post-cleanup stale desktop reservation assertion/,
    ],
    [
      'test "${#stale_after_reconciliation[@]}" -eq 0',
      'test "${#stale_after_reconciliation[@]}" -ge 0',
      /missing post-cleanup stale desktop reservation emptiness guard/,
    ],
    [
      `test "$(jq --argjson id "$release_id" '[.[] | select(.id == $id)] | length' "$releases_file")" -eq 0`,
      `test "$(jq --argjson id "$release_id" '[.[] | select(.id == $id)] | length' "$releases_file")" -ge 0`,
      /missing superseded desktop draft deletion verification/,
    ],
  ]) {
    const files = withFileChanged(desktopWorkflowFile, (content) =>
      before ===
      `jq --arg tag "$stale_tag" '[.[] | select(.tag_name == $tag)] | length'`
        ? content.replaceAll(before, after)
        : content.replace(before, after),
    );
    assert.match(validateReleaseContract(files).join("\n"), expected);
  }

  const deleteInvocation =
    '            gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${release_id}"\n';
  const movedBeforeGuards = withFileChanged(desktopWorkflowFile, (content) =>
    content
      .replace(deleteInvocation, "")
      .replace(
        '            if ! jq -e --arg expected_marker "$stale_marker" \'',
        `${deleteInvocation}            if ! jq -e --arg expected_marker "$stale_marker" '`,
      ),
  );
  assert.match(
    validateReleaseContract(movedBeforeGuards).join("\n"),
    /stale desktop deletion must follow every ambiguity, identity, emptiness, refetch, mutation, and tag guard/,
  );

  const finalGetInvocation =
    '            final_live="$(gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}")"\n';
  const movedFinalGetBeforeTagCheck = withFileChanged(
    desktopWorkflowFile,
    (content) =>
      content
        .replace(finalGetInvocation, "")
        .replace(
          "            git fetch --force --tags origin\n",
          `${finalGetInvocation}            git fetch --force --tags origin\n`,
        ),
  );
  assert.match(
    validateReleaseContract(movedFinalGetBeforeTagCheck).join("\n"),
    /stale desktop final deletion sequence must remain tag check -> immutable-ID GET -> snapshot -> equality -> DELETE/,
  );

  const currentReservationDeleted = withFileChanged(
    desktopWorkflowFile,
    (content) =>
      content.replaceAll(
        'select(((.target_commitish == $sha) and (.tag_name | startswith($tool_prefix)) and ((.body // "") | contains($marker))) | not)',
        'select((.body // "") | contains($marker_prefix))',
      ),
  );
  assert.match(
    validateReleaseContract(currentReservationDeleted).join("\n"),
    /stale desktop reconciliation must preserve the exact current SHA and intent before and after cleanup/,
  );
});

test("dropping the build matrix from the desktop release fan-in is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "needs: [impact, identity, build, decide, fan_in]",
      "needs: [impact, identity, decide, fan_in]",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing desktop release fan-in over every leg/,
  );
});

// Desktop versions and tags like every other srn-* component: rolling `YY.N`
// under a namespaced `srn-desktop-v*` tag. The old `YY.M.<run>` scheme tagged a
// bare `v*`, taking the repo-global tag namespace and the "Latest" badge.
test("an unnamespaced desktop release tag is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace('tag="${TOOL}-v${version}"', 'tag="v${version}"'),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: desktop must not publish an unnamespaced v\* tag/,
  );
});

test("dropping the namespaced desktop tag is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      'tag="${TOOL}-v${version}"',
      'tag="srn-desktop-${version}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing namespaced desktop release tag/,
  );
});

test("reverting the desktop version to the run-number scheme is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      'version="${yy}.$((max + 1))"',
      'version="$(date -u +%y).$(date -u +%-m).${GITHUB_RUN_NUMBER}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing rolling YY\.N desktop version/,
  );
});

// electron-updater throws ERR_UPDATER_INVALID_VERSION on a non-semver app
// version, and `26.1` is not semver, so the app must be built with `YY.N.0`.
test("baking the non-semver release version into the app is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "-c.extraMetadata.version=${{ needs.identity.outputs.app_version }}",
      "-c.extraMetadata.version=${{ needs.identity.outputs.version }}",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing semver app version injected into electron-builder/,
  );
});

test("a non-srn-* desktop release title is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replaceAll(
      'name="${TOOL} ${version}"',
      'name="Standard Red Notes Desktop ${version}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing srn-\* desktop release title convention/,
  );
});

test("suppressed desktop checksum failures are rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '(cd "$directory" && sha256sum --check SHA256SUMS.txt) >/dev/null',
      '(cd "$directory" && sha256sum --check SHA256SUMS.txt || true) >/dev/null',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /desktop checksum failures must not be suppressed/,
  );
});

test("desktop manifest binding preserves the reserved draft tag", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      '-f tag_name="$RELEASE_TAG" -f body="$body"',
      '-f body="$body"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing draft tag preservation during desktop manifest binding/,
  );
});

test("a non-desktop gh release that claims the Latest pointer is rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("-f make_latest=false", "-f make_latest=true"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: 1 'gh api release PATCH' release step\(s\) but 0 '-f make_latest=false' opt-out\(s\)/,
  );
});

test("GitHub release API fields preserve their REST scalar types", () => {
  let files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace("-f make_latest=false", "-F make_latest=false"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /make_latest is a REST string enum and must use raw-field '-f'/,
  );

  files = withFileChanged(".github/workflows/srn-openclaw.yml", (content) =>
    content.replace("-F draft=false", "-f draft=false"),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /draft and prerelease are REST booleans and must use typed-field '-F'/,
  );
});

test("a second non-desktop release step without the opt-out is rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"\n          gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: 2 'gh api release PATCH' release step\(s\) but 1 '-f make_latest=false' opt-out\(s\)/,
  );
});

test("srn-desktop giving away the Latest pointer is rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("-f make_latest=true", "-f make_latest=false"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: srn-desktop must claim the repo-global Latest pointer/,
  );
});

test("every publisher must fetch complete history and tags before impact analysis", () => {
  const file = ".github/workflows/srn-server.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("          fetch-depth: 0\n", "")
      .replace("          git fetch --force --tags origin\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-server\.yml: missing complete Git history checkout/,
  );
  assert.match(errors, /srn-server\.yml: missing complete release tag fetch/);
});

test("a publisher cannot tag without the unchanged-artifact decision", () => {
  const file = ".github/workflows/srn-home-server.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "    needs: [impact, build, decide, identity, package, smoke]\n",
        "    needs: [impact, build, identity, package, smoke]\n",
      )
      .replace(
        "    if: always() && needs.impact.result == 'success' && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && ((needs.package.result == 'success' && needs.smoke.result == 'success') || (needs.identity.outputs.published == 'true' && needs.package.result == 'skipped' && needs.smoke.result == 'skipped'))\n",
        "    if: always() && needs.identity.result == 'success'\n",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-home-server\.yml: release publication does not depend on decide/,
  );
  assert.match(
    errors,
    /srn-home-server\.yml: missing unchanged-release publication guard/,
  );
});

test("fingerprints must compare against the analyzer-selected base", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "BASE_REF: ${{ needs.impact.outputs.base_ref }}",
      "BASE_REF: srn-client-v00.1",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-client\.yml: missing analyzer-selected fingerprint base/,
  );
});

test("home-server fingerprints include the shipped migration payload", () => {
  const file = ".github/workflows/srn-home-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("            --path dist/bundle/migrations \\\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-home-server\.yml: missing home-server migration fingerprint input/,
  );
});

test("home-server migration packaging remains in the canonical product plan", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace('            executable: "zip",\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing home-server migration archive executable/,
  );
});

test("desktop packaging fingerprints bind lock, patches, config, toolchain, and target args", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace('            cp ../../yarn.lock "$contract/app-yarn.lock"\n', "")
      .replace(
        '            cp -a ../../.yarn/patches "$contract/yarn-patches"\n',
        "",
      )
      .replace(
        '            cp package.json "$contract/desktop-package.json"\n',
        "",
      )
      .replace(
        '            cp build/entitlements.mac.inherit.plist "$contract/desktop-mac-entitlements.plist"\n',
        "",
      )
      .replace(
        '            cp scripts/notarizeMac.js "$contract/desktop-notarize-mac.js"\n',
        "",
      )
      .replace(
        '            cp scripts/windowsSign.js "$contract/desktop-windows-sign.js"\n',
        "",
      )
      .replace(
        '              --metadata "electronVersion=${electron_version}" \\\n',
        "",
      )
      .replace(
        "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0",
        "actions/setup-python@1111111111111111111111111111111111111111 # v6.3.0",
      )
      .replace(
        'builder: "--linux AppImage deb --arm64"',
        'builder: "--linux AppImage rpm --arm64"',
      ),
  );
  const errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /missing desktop lockfile packaging input/);
  assert.match(errors, /missing desktop Yarn patch inputs/);
  assert.match(errors, /missing desktop electron-builder configuration input/);
  assert.match(errors, /missing desktop macOS entitlement fingerprint input/);
  assert.match(
    errors,
    /missing desktop macOS notarization policy fingerprint input/,
  );
  assert.match(
    errors,
    /missing desktop Windows signing policy fingerprint input/,
  );
  assert.match(errors, /missing effective Electron metadata/);
  assert.match(errors, /missing contract-bound desktop Python action/);
  assert.match(errors, /missing Linux arm64 build leg/);
  assert.match(errors, /missing contract-bound desktop target or runner/);
});

test("OpenClaw package fingerprints normalize release-only metadata", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("--normalize-package-version package/package.json \\\n", "")
      .replace(
        "--normalize-json-field package/release-package.json=/release/sourceCommit \\\n",
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(errors, /missing rolling package-version normalization/);
  assert.match(errors, /missing volatile source-commit normalization/);
});

test("mobile packaging fingerprints bind dependency locks and native toolchains", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("            --path app/yarn.lock \\\n", "")
      .replace("            --path app/packages/mobile/Gemfile.lock \\\n", "")
      .replace(
        "            --path app/packages/mobile/fastlane/Fastfile \\\n",
        "",
      )
      .replaceAll(
        "actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a",
        "actions/setup-java@1111111111111111111111111111111111111111",
      )
      .replaceAll(
        "ruby/setup-ruby@003a5c4d8d6321bd302e38f6f0ec593f77f06600",
        "ruby/setup-ruby@2222222222222222222222222222222222222222",
      )
      .replaceAll(
        "maxim-lobanov/setup-xcode@ed7a3b1fda3918c0306d1b724322adc0b8cc0a90",
        "maxim-lobanov/setup-xcode@3333333333333333333333333333333333333333",
      )
      .replace('java-version: "17"', 'java-version: "21"')
      .replaceAll('ruby-version: "3.4.7"', 'ruby-version: "3.5.0"')
      .replaceAll('xcode-version: "26"', 'xcode-version: "27"')
      .replaceAll("runs-on: macos-15", "runs-on: macos-16"),
  );
  const errors = validateReleaseContract(files).join("\n");
  assert.match(
    errors,
    /missing mobile deterministic packaging input 'app\/yarn\.lock'/,
  );
  assert.match(
    errors,
    /missing mobile deterministic packaging input 'app\/packages\/mobile\/Gemfile\.lock'/,
  );
  assert.match(
    errors,
    /unexpected external action outside contract actions\/setup-java/,
  );
  assert.match(
    errors,
    /unexpected external action outside contract ruby\/setup-ruby/,
  );
  assert.match(
    errors,
    /unexpected external action outside contract maxim-lobanov\/setup-xcode/,
  );
  assert.match(errors, /missing contract-bound Java version/);
  assert.match(errors, /missing contract-bound Ruby version/);
  assert.match(errors, /missing contract-bound Xcode version/);
  assert.match(errors, /missing iOS macOS runner/);
  assert.match(
    errors,
    /missing mobile deterministic packaging input 'app\/packages\/mobile\/fastlane\/Fastfile'/,
  );
});

test("mobile publication cannot include a stale embedded web payload", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "          rm -rf html/Web.bundle/src/web-src .release-impact\n",
      "          rm -rf .release-impact\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: missing stale embedded-web payload cleanup/,
  );
});

test("release-contract CI runs when release analysis or OpenClaw gating changes", () => {
  const file = ".github/workflows/release-contract.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace('      - ".github/workflows/srn-openclaw.yml"\n', "")
      .replace('      - "scripts/fingerprint-release-tree.mjs"\n', "")
      .replace('      - "scripts/compare-release-fingerprints.mjs"\n', "")
      .replace('      - "app/packages/mobile/fastlane/**"\n', "")
      .replace('      - "docs/ci-production-gates.md"\n', "")
      .replace('      - "scripts/validate-release-contract.mjs"\n', ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /release-contract\.yml: expected \.github\/workflows\/srn-openclaw\.yml in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/fingerprint-release-tree\.mjs in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/compare-release-fingerprints\.mjs in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/validate-release-contract\.mjs in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected app\/packages\/mobile\/fastlane\/\*\* in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected docs\/ci-production-gates\.md in both push and pull_request paths, found 1/,
  );
});

test("publisher concurrency and write permissions stay product-scoped", () => {
  const file = ".github/workflows/srn-admin.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "permissions:\n  contents: read",
        "permissions:\n  contents: write",
      )
      .replace(
        "concurrency:\n  group: srn-admin-release\n  cancel-in-progress: false\n\n",
        "",
      )
      .replaceAll("    permissions:\n      contents: write\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-admin\.yml: missing read-only workflow permissions/,
  );
  assert.match(errors, /srn-admin\.yml: missing per-product concurrency/);
  assert.match(
    errors,
    /srn-admin\.yml: missing non-cancelling release concurrency/,
  );
  assert.match(errors, /srn-admin\.yml: missing native draft permission/);
  assert.match(
    errors,
    /srn-admin\.yml: missing publication-only write permission/,
  );
});

test("rolling versions use every tag rather than a truncated release list", () => {
  const file = ".github/workflows/srn-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'git tag --list "${prefix}*"',
      "gh release list --limit 200 --json tagName --jq '.[].tagName'",
    ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-server\.yml: missing collision-safe rolling version source/,
  );
  assert.match(
    errors,
    /srn-server\.yml: rolling versions must use complete tag history/,
  );
});

test("mobile refuses to reuse an existing version tag", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '          if git show-ref --verify --quiet "refs/tags/$tag"; then\n',
      "          if false; then\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: missing mobile tag collision guard/,
  );
});

test("release-contract CI produces both complete report formats", () => {
  const file = ".github/workflows/release-contract.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("            --all-workspaces all \\\n", "")
      .replace("            --output release-impact.json \\\n", "")
      .replace("            --report release-impact.md\n", "")
      .replace(
        "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n",
        "        run: true\n",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /release-contract\.yml: missing all-workspace release analysis/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing machine-readable release report/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing readable release report/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing immutable release report artifact publication/,
  );
});

test("product tag profiles and workspace classification cannot drift", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        '  "srn-mobile": {\n    ...appProductConfig,\n    tagPrefix: "@standardnotes/mobile@",\n    versioning: "semver",',
        '  "srn-mobile": {\n    ...appProductConfig,\n    tagPrefix: "@standardnotes/mobile@",\n    versioning: "rolling-year",',
      )
      .replace(
        "    const releaseTargets = releaseTargetsForPackage(packageName);",
        "    const releaseTargets = [];",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing srn-mobile semver tag profile/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: all workspace modes must use the managed-product category mapping/,
  );
});

test("hybrid history ambiguity and package-version collisions stay fail-closed", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace('"ambiguous-hybrid-release-history"', '"hybrid-history-ignored"')
      .replace('"release-version-collision"', '"release-version-ignored"'),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing hybrid topology ambiguity guard/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing hybrid package-version collision guard/,
  );
});

test("the impact hand-off to later jobs stays bounded", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "const MAX_GITHUB_OUTPUT_BYTES = 30000;",
        "const MAX_GITHUB_OUTPUT_BYTES = 30000000;",
      )
      .replace('"github-output-too-large"', '"github-output-accepted"')
      .replace(
        "matchedFileCount: result.matchedFiles.length",
        "matchedFiles: result.matchedFiles",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing bounded cross-job GitHub outputs/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing oversized GitHub output guard/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing path-count impact hand-off/,
  );
});

test("computed dependency closure must remain covered by publisher paths", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace('      - "app/packages/api/**"\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: push paths do not cover release dependency '@standardnotes\/api' at 'app\/packages\/api\/\*\*'/,
  );
});

test("desktop trigger paths cover reusable and shared build configuration", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        '      - "app/.github/workflows/desktop.release.reuse.yml"\n',
        "",
      )
      .replace('      - "app/babel.config.js"\n', ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-desktop\.yml: push paths do not cover release configuration 'app\/\.github\/workflows\/desktop\.release\.reuse\.yml'/,
  );
  assert.match(
    errors,
    /srn-desktop\.yml: push paths do not cover release configuration 'app\/babel\.config\.js'/,
  );
});

test("product publishers do not wake for shared release-gate changes", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      - "cli/srn-client/**"\n',
      '      - "cli/srn-client/**"\n      - "scripts/**"\n',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-client\.yml: product publisher paths must not include shared release gate 'scripts\/analyze-release-impact\.mjs'/,
  );
});

test("force inputs can only come from an audited manual dispatch", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "FORCE_RELEASE: ${{ github.event_name == 'workflow_dispatch' && inputs.force_release || false }}",
      "FORCE_RELEASE: ${{ startsWith(github.ref, 'refs/tags/') || inputs.force_release }}",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing manual-only force source/,
  );
});

test("an explicit OpenClaw tag is excluded from its own prior-release baseline", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "          EXCLUDED_RELEASE_REF: ${{ startsWith(github.ref, 'refs/tags/srn-openclaw-v') && github.ref_name || (github.event_name == 'workflow_dispatch' && inputs.tag) || '' }}\n",
        "",
      )
      .replace(
        '            --exclude-release-ref "${excluded_release_ref}" \\\n',
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-openclaw\.yml: missing explicit OpenClaw release-ref exclusion/,
  );
  assert.match(
    errors,
    /srn-openclaw\.yml: missing explicit OpenClaw self-tag exclusion forwarding/,
  );
});

test("mobile branch analysis cannot silently become publication", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "if: needs.impact.outputs.changed == 'true' && needs.impact.outputs.publish_requested == 'true'",
        "if: needs.impact.outputs.changed == 'true'",
      )
      .replace(
        '              echo "force_release requires publish_release=true; an analysis-only dispatch cannot force publication." >&2\n',
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-mobile\.yml: missing mobile impact-versus-publication gate/,
  );
  assert.match(
    errors,
    /srn-mobile\.yml: missing fail-closed manual force intent/,
  );
});

test("workflow-created mobile tags cannot recursively trigger publication", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      - "@standardnotes/web@*"\n',
      '      - "@standardnotes/web@*"\n      - "@standardnotes/mobile@*"\n',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /workflow-created mobile tags must not recursively trigger mobile publication/,
  );
});

test("normal CI always publishes one non-releasing all-workspace report", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("          fetch-depth: 0\n", "")
      .replace("          git fetch --force --tags origin\n", "")
      .replace("            --all-workspaces all \\\n", "")
      .replace(
        `        uses: ${approvedWorkflowAction("uploadArtifact")}\n`,
        "        run: true\n",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /ci\.yml: missing complete normal-CI report history checkout/,
  );
  assert.match(errors, /ci\.yml: missing complete normal-CI tag fetch/);
  assert.match(errors, /ci\.yml: missing normal-CI all-workspace analysis/);
  assert.match(
    errors,
    /ci\.yml: normal CI must emit exactly one all-workspace impact report/,
  );
  assert.match(
    errors,
    /ci\.yml: missing normal-CI release-impact evidence upload/,
  );
});

test("release validation also enforces the CI and Pages action allowlist", () => {
  for (const [file, actionName] of [
    [".github/workflows/ci.yml", "checkout"],
    [".github/workflows/docs-pages.yml", "checkout"],
  ]) {
    const approved = approvedWorkflowAction(actionName);
    const [immutableUse, version] = approved.split(" # ");
    const action = immutableUse.slice(0, immutableUse.lastIndexOf("@"));

    let files = withFileChanged(file, (content) =>
      content.replace(approved, `${action}@${version} # ${version}`),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /mutable external action reference/,
    );

    files = withFileChanged(file, (content) =>
      content.replace(approved, `${action}@${"1".repeat(40)} # ${version}`),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      /unapproved external action reference/,
    );
  }
});

test("normal CI release reporting cannot gain a publisher", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "      - name: Install release policy dependencies",
      "      - name: Accidental publisher\n        run: gh release create bad-tag\n      - name: Install release policy dependencies",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /CI outside publish-containers must not publish releases \(gh release create\)/,
  );
});

test("normal CI release reporting cannot gain publication permissions", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "permissions:\n  contents: read",
      "permissions:\n  contents: write",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /CI outside publish-containers must not publish releases \(contents: write\)/,
  );
});

test("container publication remains behind the protected main acceptance boundary", () => {
  const file = ".github/workflows/ci.yml";
  const files = withTerminalJobChanged(file, "publish-containers", (content) =>
    content
      .replace(
        "needs: [container-smoke, production-gate]",
        "needs: [container-smoke]",
      )
      .replace("github.ref == 'refs/heads/main'", "github.ref != ''")
      .replace(
        "github.repository == 'supermarsx/standard-red-notes'",
        "github.repository != ''",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /missing container acceptance and production-gate fan-in/,
  );
  assert.match(errors, /missing main-only container publication/);
  assert.match(errors, /missing first-party container publication/);
});

test("container publication preserves non-cancelling retry-stable producer identity", () => {
  const file = ".github/workflows/ci.yml";
  const cancellable = withFileChanged(file, (content) =>
    content
      .replace(
        "group: ci-${{ github.event_name }}-${{ (github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'supermarsx/standard-red-notes') && github.run_id || github.event.pull_request.number || github.ref }}",
        "group: ci-${{ github.event.pull_request.number || github.ref }}",
      )
      .replace(
        "cancel-in-progress: ${{ github.event_name != 'push' || github.ref != 'refs/heads/main' || github.repository != 'supermarsx/standard-red-notes' }}",
        "cancel-in-progress: true",
      ),
  );
  const concurrencyErrors = validateReleaseContract(cancellable).join("\n");
  assert.match(
    concurrencyErrors,
    /missing run-isolated protected-main CI concurrency/,
  );
  assert.match(
    concurrencyErrors,
    /missing non-cancelling protected-main container publication/,
  );

  const currentAttempt = withTerminalJobChanged(
    file,
    "publish-containers",
    (content) =>
      content.replace(
        "PUBLISH_ATTEMPT: ${{ needs.container-smoke.outputs.publication_attempt }}",
        "PUBLISH_ATTEMPT: ${{ github.run_attempt }}",
      ),
  );
  assert.match(
    validateReleaseContract(currentAttempt).join("\n"),
    /must reuse producer identity across failed-job reruns/,
  );
});

test("protected container publication cannot execute repository code", () => {
  const file = ".github/workflows/ci.yml";
  const files = withTerminalJobChanged(file, "publish-containers", (content) =>
    content.replace(
      "      - name: Download the exact tested container bundle",
      `      - uses: ${approvedWorkflowAction("checkout")}\n      - name: Download the exact tested container bundle`,
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /protected container publisher must not check out repository code/,
  );
});

test("every publisher uses the fail-closed shared fingerprint comparator", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "node scripts/compare-release-fingerprints.mjs",
        'gh release download "$BASE_REF"',
      )
      .replace(
        "BASELINE_STATUS: ${{ needs.impact.outputs.baseline_status }}",
        "BASELINE_STATUS: ancestor",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-client\.yml: missing shared fail-closed fingerprint comparator/,
  );
  assert.match(
    errors,
    /srn-client\.yml: fingerprint comparison must use the shared fail-closed comparator/,
  );
  assert.match(
    errors,
    /srn-client\.yml: missing analyzer-selected baseline status/,
  );
});

test("fingerprint comparator failure modes remain explicit and blocking", () => {
  const file = "scripts/compare-release-fingerprints.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace('"missing-prior-fingerprint"', '"missing-prior-ignored"')
      .replace('decision: "blocked"', 'decision: "release-changed"'),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /compare-release-fingerprints\.mjs: missing missing baseline asset block/,
  );
  assert.match(
    errors,
    /compare-release-fingerprints\.mjs: missing persisted blocked evidence/,
  );
});

test("unmanaged and private workspaces stay inventory-only", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        'analysisStatus: "inventory-only"',
        'analysisStatus: "release-managed"',
      )
      .replaceAll("publicationPolicy", "legacyPolicy"),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing inventory-only unmanaged rows/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing explicit workspace publication policy/,
  );
});

test("workflow ownership remains complete, scoped, and fail-closed", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replaceAll("discoverWorkflowOwnership", "discoverLegacyOwnership")
      .replaceAll(
        '"unclassified-external-mutation-workflow"',
        '"ignored-external-mutation-workflow"',
      )
      .replaceAll(
        '"quarantined-workflow-reactivated"',
        '"quarantined-workflow-allowed"',
      )
      .replaceAll("declaredTriggers", "implicitTriggers")
      .replaceAll("rootDiscoverable", "rootMaybeDiscoverable")
      .replaceAll("embeddedPortable", "embeddedMaybePortable"),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing complete workflow ownership inventory/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing unclassified external mutation guard/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing quarantined publisher reactivation guard/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing reported declared workflow triggers/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing root-discoverability workflow metadata/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing embedded-portability workflow metadata/,
  );
});

test("release workflow job inventories reject hidden extra jobs", () => {
  for (const file of [
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-openclaw.yml",
    ".github/workflows/srn-desktop.yml",
    ".github/workflows/release-contract.yml",
  ]) {
    const files = withFileChanged(
      file,
      (content) =>
        `${content}\n  unreviewed_job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`,
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      new RegExp(
        `${file.replaceAll(".", "\\.")}: job set must exactly match the release contract`,
      ),
    );
  }
});

test("a reservation step cannot stop without saying why", () => {
  for (const [file, nextJobName] of [
    [".github/workflows/srn-home-server.yml", "package"],
    [".github/workflows/srn-admin.yml", "package"],
    [".github/workflows/srn-client.yml", "package"],
    [".github/workflows/srn-mcp.yml", "package"],
    [".github/workflows/srn-server.yml", "package"],
    [".github/workflows/srn-desktop.yml", "build"],
  ]) {
    for (const [fragment, replacement, expected] of [
      [
        'echo "::error title=${TOOL} release reservation refused::${annotation}"',
        'echo "${annotation}"',
        /missing reservation refusal annotation/,
      ],
      [
        '} >> "$GITHUB_STEP_SUMMARY"\n            exit 1',
        "} > /dev/null\n            exit 1",
        /missing reservation refusal job summary/,
      ],
      [
        `trap 'step_stopped "$?"' EXIT`,
        "trap - EXIT",
        /missing failed reservation command exit report/,
      ],
      [
        "trap 'failed_line=$LINENO; failed_command=$BASH_COMMAND' ERR",
        "trap - ERR",
        /missing failed reservation command capture/,
      ],
      [
        'echo "::error title=${TOOL} release reservation failed::${annotation}"',
        'echo "${annotation}" >&2',
        /missing failed reservation command annotation/,
      ],
      [
        "created \\(.created_at)\\t\\(.assets | length) asset(s)\\t\\(.html_url)",
        "stale",
        /missing stale draft age, asset count, and page in the refusal/,
      ],
      [
        "gh api --method DELETE repos/",
        "gh release delete ",
        /missing stale draft discard command in the refusal/,
      ],
      [
        "re-run the failed jobs of the run that reserved it, listed by gh run list --repo",
        "re-run the run that reserved it",
        /missing stale draft finishing route in the refusal/,
      ],
      [
        '            refuse "more than one release is reserved',
        '            echo "ambiguous" >&2\n            exit 1\n            refuse "more than one release is reserved',
        /every reservation refusal must go through refuse\(\), the only exit 1 in the step/,
      ],
      [
        'test "$(git rev-parse HEAD)" = "$GITHUB_SHA" ||\n            refuse',
        'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n          true ||\n            refuse',
        /reservation assertions must report through refuse\(\): test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/,
      ],
      [
        '\' <<< "$IMPACT_RESULT" >/dev/null ||\n            refuse',
        '\' <<< "$IMPACT_RESULT" >/dev/null\n          true ||\n            refuse',
        /reservation assertions must report through refuse\(\): ' <<< "\$IMPACT_RESULT" >\/dev\/null/,
      ],
      [
        '[[ "$FORCED" == "true" || "$FORCED" == "false" ]] ||\n            refuse',
        '[[ "$FORCED" == "true" || "$FORCED" == "false" ]]\n          true ||\n            refuse',
        /reservation assertions must report through refuse\(\): \[\[ "\$FORCED" == "true" \|\| "\$FORCED" == "false" \]\]/,
      ],
      [
        'git show-ref --verify --quiet "refs/tags/${tag}" ||\n                refuse',
        'git show-ref --verify --quiet "refs/tags/${tag}"\n              true ||\n                refuse',
        /reservation assertions must report through refuse\(\): git show-ref --verify --quiet "refs\/tags\/\$\{tag\}"/,
      ],
    ]) {
      const files = withJobChanged(file, "identity", nextJobName, (job) =>
        job.replaceAll(fragment, replacement),
      );
      assert.match(
        validateReleaseContract(files).join("\n"),
        expected,
        `${file}: ${fragment}`,
      );
    }
  }
});

// The reservation steps are inline shell. Everything below runs each step's
// actual `run:` block under bash, exactly as the hosted runner starts it,
// against a stand-in for `gh` and a throwaway Git repository, so the decisions
// and the refusal text are exercised rather than pattern-matched. That needs
// a bash with mapfile, jq, and git. CI has them; where they are missing
// outside CI each of these tests is skipped by name with the reason.
const RESERVATION_REPOSITORY = "example-owner/example-repo";
const RESERVATION_BOT = Object.freeze({
  login: "github-actions[bot]",
  id: 41898282,
  type: "Bot",
});
const RESERVATION_FINGERPRINT = "a".repeat(64);
const RESERVATION_YEAR = String(new Date().getUTCFullYear() % 100).padStart(
  2,
  "0",
);

function reservationShellProblem() {
  if (process.platform === "win32") {
    return "the reservation steps are bash scripts for a Linux runner";
  }
  for (const [command, args] of [
    [
      "bash",
      ["-c", 'mapfile -t probe < <(printf "a\\n"); test "${probe[0]}" = a'],
    ],
    ["jq", ["--version"]],
    ["git", ["--version"]],
  ]) {
    if (spawnSync(command, args, { stdio: "ignore" }).status !== 0) {
      return `${command} is missing or too old`;
    }
  }
  return null;
}

const reservationShellProblemFound = reservationShellProblem();
const reservationRuns = {
  skip:
    reservationShellProblemFound !== null &&
    process.env.CI !== "true" &&
    process.env.GITHUB_ACTIONS !== "true"
      ? `${reservationShellProblemFound}; CI executes these`
      : false,
};

// Serves the four release requests the reservation steps make from a JSON
// file, records every invocation, and fails on anything it does not know.
const RESERVATION_FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (message, code = 1) => {
  save();
  process.stderr.write(message + "\n");
  process.exit(code);
};
if (args[0] !== "api") fail("fake gh: unsupported command: " + args.join(" "), 97);
let method = "GET";
let route = null;
let paginate = false;
let slurp = false;
const fields = {};
for (let index = 1; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--method") {
    method = args[(index += 1)];
  } else if (argument === "-f" || argument === "-F") {
    const pair = args[(index += 1)];
    const separator = pair.indexOf("=");
    const raw = pair.slice(separator + 1);
    fields[pair.slice(0, separator)] =
      argument === "-F" && (raw === "true" || raw === "false") ? raw === "true" : raw;
  } else if (argument === "--paginate") {
    paginate = true;
  } else if (argument === "--slurp") {
    slurp = true;
  } else if (!argument.startsWith("-") && route === null) {
    route = argument;
  } else {
    fail("fake gh: unsupported argument: " + argument, 97);
  }
}
const base = "repos/" + state.repository + "/releases";
const byId = route.startsWith(base + "/") && /^[0-9]+$/.test(route.slice(base.length + 1));
const kind =
  method === "GET" && route === base + "?per_page=100"
    ? "list"
    : method === "GET" && byId
      ? "get"
      : method === "POST" && route === base
        ? "create"
        : method === "DELETE" && byId
          ? "delete"
          : null;
if (kind === null) fail("fake gh: unsupported request: " + method + " " + route, 97);
state.counts[kind] = (state.counts[kind] || 0) + 1;
// Scripted interference: what another actor does just before the nth request of a kind.
for (const event of state.events) {
  if (event.on !== kind || event.nth !== state.counts[kind]) continue;
  if (event.fail) fail(event.fail);
  if (event.add) state.releases.unshift(event.add);
  if (event.patch) {
    Object.assign(
      state.releases.find((release) => release.id === event.patch.id),
      event.patch.fields,
    );
  }
}
if (kind === "list") {
  if (!paginate || !slurp) fail("fake gh: the inventory must be read with --paginate --slurp", 97);
  const pages = [];
  for (let offset = 0; offset < state.releases.length; offset += 100) {
    pages.push(state.releases.slice(offset, offset + 100));
  }
  if (pages.length === 0) pages.push([]);
  save();
  process.stdout.write(JSON.stringify(pages) + "\n");
} else if (kind === "get") {
  const id = Number(route.slice(base.length + 1));
  const release = state.releases.find((candidate) => candidate.id === id);
  if (!release) fail("gh: Not Found (HTTP 404)");
  save();
  process.stdout.write(JSON.stringify(release) + "\n");
} else if (kind === "create") {
  const release = {
    id: state.nextId,
    tag_name: fields.tag_name,
    name: fields.name,
    target_commitish: fields.target_commitish,
    draft: fields.draft,
    prerelease: fields.prerelease,
    immutable: false,
    created_at: "2026-01-01T00:00:00Z",
    published_at: null,
    html_url: "https://github.com/" + state.repository + "/releases/tag/untagged-" + state.nextId,
    author: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
    assets: [],
    body:
      fields.body +
      (fields.generate_release_notes
        ? "\n\n**Full Changelog**: https://github.com/" + state.repository + "/commits/" + fields.tag_name
        : ""),
    ...(state.createOverride || {}),
  };
  state.nextId += 1;
  state.releases.unshift(release);
  save();
  process.stdout.write(JSON.stringify(release) + "\n");
} else {
  const id = Number(route.slice(base.length + 1));
  const before = state.releases.length;
  state.releases = state.releases.filter((candidate) => candidate.id !== id);
  if (state.releases.length === before) fail("gh: Not Found (HTTP 404)");
  save();
}
`;

function reservationRunBlock(file, stepName) {
  const lines = baseline.get(file).replaceAll("\r\n", "\n").split("\n");
  const nameIndex = lines.findIndex(
    (line) => line.trim().replace(/^- /, "") === `name: ${stepName}`,
  );
  assert.notEqual(nameIndex, -1, `${file} must contain step ${stepName}`);
  const runIndex = lines.findIndex(
    (line, index) => index > nameIndex && /^\s+run: \|$/.test(line),
  );
  assert.notEqual(runIndex, -1, `${file}: ${stepName} must have a run block`);
  assert.equal(
    lines.slice(nameIndex + 1, runIndex).some((line) => /^\s+- /.test(line)),
    false,
    `${file}: the run block must belong to ${stepName}`,
  );
  const indent = lines[runIndex].indexOf("run:") + 2;
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) {
      break;
    }
    body.push(line.trim() === "" ? "" : line.slice(indent));
  }
  while (body.at(-1) === "") {
    body.pop();
  }
  return `${body.join("\n")}\n`;
}

function reservationGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Release Contract Tests",
      GIT_AUTHOR_EMAIL: "release-contract@example.invalid",
      GIT_COMMITTER_NAME: "Release Contract Tests",
      GIT_COMMITTER_EMAIL: "release-contract@example.invalid",
    },
  }).trim();
}

// `tags` are [name, "head" | "previous"] and exist only on the remote, so the
// step's own fetch has to bring them in, as on a fresh runner checkout.
// `releases`, `events`, and `createOverride` may be functions of the two SHAs.
function reservationFixture({
  releases = [],
  tags = [],
  events = [],
  createOverride = null,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "srn-reservation-"));
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  const bin = path.join(root, "bin");
  mkdirSync(work);
  mkdirSync(bin);
  reservationGit(root, "init", "--quiet", "--bare", origin);
  reservationGit(work, "init", "--quiet", "--initial-branch=main");
  writeFileSync(path.join(work, "source.txt"), "previous\n");
  reservationGit(work, "add", "source.txt");
  reservationGit(work, "commit", "--quiet", "-m", "previous");
  const previousSha = reservationGit(work, "rev-parse", "HEAD");
  writeFileSync(path.join(work, "source.txt"), "head\n");
  reservationGit(work, "commit", "--quiet", "-am", "head");
  const headSha = reservationGit(work, "rev-parse", "HEAD");
  reservationGit(work, "remote", "add", "origin", origin);
  reservationGit(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  for (const [name, at] of tags) {
    reservationGit(
      work,
      "push",
      "--quiet",
      "origin",
      `${at === "head" ? headSha : previousSha}:refs/tags/${name}`,
    );
  }
  writeFileSync(path.join(bin, "gh"), RESERVATION_FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  const shas = { headSha, previousSha };
  const resolve = (value) =>
    typeof value === "function" ? value(shas) : value;
  const statePath = path.join(root, "gh-state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      repository: RESERVATION_REPOSITORY,
      releases: resolve(releases),
      nextId: 900000001,
      calls: [],
      counts: {},
      events: resolve(events),
      createOverride: resolve(createOverride),
    }),
  );
  return {
    root,
    work,
    bin,
    statePath,
    headSha,
    previousSha,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runReservationStep(fixture, runBlock, environment) {
  const script = path.join(fixture.root, "step.sh");
  const output = path.join(fixture.root, "github-output.txt");
  const summary = path.join(fixture.root, "github-step-summary.md");
  writeFileSync(script, runBlock);
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = spawnSync(
    "bash",
    // The shell line the hosted runner prints for these steps.
    ["--noprofile", "--norc", "-e", "-o", "pipefail", script],
    {
      cwd: fixture.work,
      encoding: "utf8",
      env: {
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
        HOME: fixture.root,
        TMPDIR: fixture.root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        FAKE_GH_STATE: fixture.statePath,
        GH_TOKEN: "not-a-token",
        GITHUB_REPOSITORY: RESERVATION_REPOSITORY,
        GITHUB_SHA: fixture.headSha,
        GITHUB_RUN_ID: "4242",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...environment,
      },
    },
  );
  const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  const stdout = result.stdout ?? "";
  const annotations = stdout
    .split("\n")
    .filter((line) => line.startsWith("::error "));
  return {
    status: result.status,
    spawnError: result.error?.code ?? null,
    stdout,
    stderr: result.stderr ?? "",
    annotations,
    // What the run page shows once the runner has decoded the annotation.
    annotationText: annotations
      .join("\n")
      .replaceAll("%0A", "\n")
      .replaceAll("%0D", "\r")
      .replaceAll("%25", "%"),
    outputText: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
    // Every gh invocation, argument for argument, in the order it was made.
    calls: state.calls,
  };
}

// The exact gh command lines behind the short request names the cases use.
function reservationCall(request, { tool, sha, marker }) {
  const releases = `repos/${RESERVATION_REPOSITORY}/releases`;
  const [kind, subject] = request.split(" ");
  if (kind === "list") {
    return ["api", `${releases}?per_page=100`, "--paginate", "--slurp"];
  }
  if (kind === "get") {
    return ["api", `${releases}/${subject}`];
  }
  if (kind === "DELETE") {
    return ["api", "--method", "DELETE", `${releases}/${subject}`];
  }
  assert.equal(kind, "POST");
  return [
    "api",
    "--method",
    "POST",
    releases,
    "-f",
    `tag_name=${subject}`,
    "-f",
    `target_commitish=${sha}`,
    "-f",
    `name=${tool} ${subject.slice(`${tool}-v`.length)}`,
    "-f",
    `body=${marker}`,
    "-F",
    "draft=true",
    "-F",
    "prerelease=false",
    "-F",
    "generate_release_notes=true",
  ];
}

function reservedRelease({
  id,
  tool,
  n,
  sha,
  body,
  draft = true,
  assets = [],
  author = RESERVATION_BOT,
  immutable = false,
  tag = `${tool}-v${RESERVATION_YEAR}.${n}`,
  name = `${tool} ${RESERVATION_YEAR}.${n}`,
}) {
  return {
    id,
    tag_name: tag,
    name,
    target_commitish: sha,
    draft,
    prerelease: false,
    immutable,
    created_at: "2026-08-27T15:32:13Z",
    published_at: draft ? null : "2026-08-27T16:00:00Z",
    html_url: `https://github.com/${RESERVATION_REPOSITORY}/releases/tag/${draft ? `untagged-${id}` : tag}`,
    author,
    assets,
    // GitHub appends generated notes to the marker a draft was created with.
    body: draft
      ? `${body}\n\n**Full Changelog**: https://github.com/${RESERVATION_REPOSITORY}/commits/${tag}`
      : body,
  };
}

const nativeReservationMarker = (
  tool,
  sha,
  fingerprint = RESERVATION_FINGERPRINT,
  intent = "automatic",
) =>
  `<!-- srn-release-reservation tool=${tool} commit=${sha} fingerprint=${fingerprint} intent=${intent} -->`;
const desktopReservationMarker = (sha, intent = "automatic") =>
  `<!-- srn-release-reservation tool=srn-desktop commit=${sha} intent=${intent} -->`;

// The hand-off exactly as the impact job writes it, so the step is tested
// against what the analyzer really emits.
function impactHandOff(headSha, forced = false, forceReason = null) {
  return githubOutputs({
    schemaVersion: 1,
    mode: "single",
    identity: "fixture",
    changed: true,
    forced,
    forceReason,
    firstRelease: false,
    noAncestorBaseline: false,
    baselineStatus: "ancestor",
    publicationGate: forced ? "force-requested" : "build-and-compare",
    baseRef: null,
    baseSha: null,
    excludedReleaseRef: null,
    headSha,
    matchedFiles: ["packages/fixture/src/index.ts"],
    reasons: [{ code: "target-package-change", paths: ["a"] }],
  }).result_json;
}

function publishedReservationHistory(tool, numbers) {
  return {
    releases: ({ previousSha }) =>
      numbers.map((n) =>
        reservedRelease({
          id: 100 + n,
          tool,
          n,
          sha: previousSha,
          draft: false,
          body: `${tool} ${RESERVATION_YEAR}.${n}`,
        }),
      ),
    tags: numbers.map((n) => [`${tool}-v${RESERVATION_YEAR}.${n}`, "previous"]),
  };
}

// A step that reserves or reuses leaves exactly these bytes behind and prints
// nothing: the gh commands it ran, the outputs later jobs read, and its
// summary. A step that stops runs exactly the listed gh commands, writes no
// output, and says why where a person will look.
function assertReservation(runBlock, scenario) {
  assert.equal(reservationShellProblemFound, null);
  const fixture = reservationFixture(scenario.fixture);
  try {
    const result = runReservationStep(
      fixture,
      runBlock,
      scenario.environment(fixture),
    );
    const expected = scenario.expected;
    const context = `${result.stdout}\n${result.stderr}`;
    const intent = expected.intent ?? "automatic";
    assert.equal(result.spawnError, null, context);
    assert.deepEqual(
      result.calls,
      expected.requests.map((request) =>
        reservationCall(request, {
          tool: scenario.tool,
          sha: fixture.headSha,
          marker: scenario.marker(fixture.headSha, intent),
        }),
      ),
      context,
    );
    const outputs = expected.reserves ?? expected.reuses;
    if (outputs) {
      assert.equal(result.status, 0, context);
      assert.equal(result.stdout, "");
      assert.equal(
        result.outputText,
        Object.entries(outputs)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
      );
      assert.equal(
        result.summary,
        [
          ...(expected.summary ?? []),
          scenario.reservedSummary(fixture.headSha, intent, outputs),
          "",
        ].join("\n"),
      );
      return;
    }
    assert.equal(result.status, 1, context);
    assert.equal(result.outputText, "", context);
    assert.equal(result.annotations.length, 1, context);
    const refused = expected.refuses !== undefined;
    assert.match(
      result.annotations[0],
      new RegExp(
        `^::error title=${scenario.tool} release reservation ${refused ? "refused" : "failed"}::`,
      ),
    );
    for (const fragment of (expected.refuses ?? expected.fails)(fixture)) {
      assert.ok(
        result.annotationText.includes(fragment),
        `annotation lacks ${JSON.stringify(fragment)}:\n${result.annotationText}`,
      );
      if (refused) {
        assert.ok(
          result.summary.includes(fragment),
          `job summary lacks ${JSON.stringify(fragment)}:\n${result.summary}`,
        );
        assert.ok(
          result.stderr.includes(fragment),
          `log lacks ${JSON.stringify(fragment)}:\n${result.stderr}`,
        );
      }
    }
    for (const fragment of expected.log ?? []) {
      assert.ok(result.stderr.includes(fragment), context);
    }
  } finally {
    fixture.cleanup();
  }
}

// The two ways out of a stale draft, as the refusal prints them.
const staleDraftExits = (tool, id, sha) => [
  `  discard ${id}: gh api --method DELETE repos/${RESERVATION_REPOSITORY}/releases/${id}`,
  `  or finish ${id}: re-run the failed jobs of the run that reserved it, listed by gh run list --repo ${RESERVATION_REPOSITORY} --workflow ${tool} --commit ${sha}`,
];

function nativeReservation(tool) {
  return {
    tool,
    marker: (sha, intent) =>
      nativeReservationMarker(tool, sha, RESERVATION_FINGERPRINT, intent),
    reservedSummary: (sha, intent, outputs) =>
      `Reserved ${outputs.tag} for ${sha} at ${RESERVATION_FINGERPRINT} with intent ${intent} (release id ${outputs.release_id}; reused=${outputs.reused}; published=${outputs.published})`,
  };
}

const desktopReservation = Object.freeze({
  tool: "srn-desktop",
  marker: (sha, intent) => desktopReservationMarker(sha, intent),
  reservedSummary: (sha, intent, outputs) =>
    `Reserved ${outputs.tag} for ${sha} with intent ${intent} (id ${outputs.release_id}; reused=${outputs.reused}; published=${outputs.published}).`,
});

function nativeReservationScenarios(tool) {
  const year = RESERVATION_YEAR;
  const environment = (fixture) => ({
    TOOL: tool,
    EXPECTED_FINGERPRINT: RESERVATION_FINGERPRINT,
    FORCED: "false",
    IMPACT_RESULT: impactHandOff(fixture.headSha),
  });
  const history = publishedReservationHistory(tool, [1, 2, 3]);
  const withHistory = (extra, extraTags = []) => ({
    releases: (shas) => [...extra(shas), ...history.releases(shas)],
    tags: [...history.tags, ...extraTags],
  });
  const reserved = (n, overrides = {}) => ({
    version: `${year}.${n}`,
    tag: `${tool}-v${year}.${n}`,
    release_id: "900000001",
    reused: "false",
    published: "false",
    ...overrides,
  });
  const own =
    (id, overrides = {}) =>
    ({ headSha }) => [
      reservedRelease({
        id,
        tool,
        n: 4,
        sha: headSha,
        body: nativeReservationMarker(tool, headSha),
        ...overrides,
      }),
    ];
  return [
    {
      name: "no release of the tool yet reserves YY.1",
      fixture: {},
      environment,
      expected: {
        reserves: reserved(1),
        requests: ["list", `POST ${tool}-v${year}.1`],
      },
    },
    {
      name: "published history reserves the next number",
      fixture: history,
      environment,
      expected: {
        reserves: reserved(4),
        requests: ["list", `POST ${tool}-v${year}.4`],
      },
    },
    {
      name: "a draft for this commit, fingerprint, and intent is reused",
      fixture: withHistory(own(500)),
      environment,
      expected: {
        reuses: reserved(4, { release_id: "500", reused: "true" }),
        requests: ["list"],
      },
    },
    {
      name: "a release already published from this commit is reported as published",
      fixture: withHistory(own(500, { draft: false }), [
        [`${tool}-v${year}.4`, "head"],
      ]),
      environment,
      expected: {
        reuses: reserved(4, {
          release_id: "500",
          reused: "true",
          published: "true",
        }),
        requests: ["list"],
      },
    },
    {
      // The state that stopped srn-home-server from 2026-08-27: a draft left
      // by a run whose upload failed, and every later commit refused.
      name: "a draft reserved for another commit is refused with its id, age, assets, and both ways out",
      fixture: withHistory(({ previousSha }) => [
        reservedRelease({
          id: 377935393,
          tool,
          n: 4,
          sha: previousSha,
          body: nativeReservationMarker(tool, previousSha),
          assets: [{ id: 1, name: `${tool}-linux-x64` }],
        }),
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          `a draft ${tool} release is still reserved for another commit, fingerprint or intent`,
          `this run reserves: commit=${fixture.headSha} fingerprint=${RESERVATION_FINGERPRINT} intent=automatic`,
          `  377935393\t${tool}-v${year}.4\t${fixture.previousSha}\tcreated 2026-08-27T15:32:13Z\t1 asset(s)\thttps://github.com/${RESERVATION_REPOSITORY}/releases/tag/untagged-377935393`,
          "Reconcile or delete the stale drafts explicitly, then rerun. For each draft, one of:",
          ...staleDraftExits(tool, 377935393, fixture.previousSha),
        ],
        requests: ["list"],
      },
    },
    {
      name: "a draft for this commit with another fingerprint is refused",
      fixture: withHistory(({ headSha }) => [
        reservedRelease({
          id: 501,
          tool,
          n: 4,
          sha: headSha,
          body: nativeReservationMarker(tool, headSha, "b".repeat(64)),
        }),
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          `  501\t${tool}-v${year}.4\t${fixture.headSha}\tcreated 2026-08-27T15:32:13Z\t0 asset(s)`,
          ...staleDraftExits(tool, 501, fixture.headSha),
        ],
        requests: ["list"],
      },
    },
    {
      name: "another tool's draft is ignored",
      fixture: withHistory(({ previousSha }) => [
        reservedRelease({
          id: 502,
          tool: "srn-other",
          n: 9,
          sha: previousSha,
          body: nativeReservationMarker("srn-other", previousSha),
        }),
      ]),
      environment,
      expected: {
        reserves: reserved(4),
        requests: ["list", `POST ${tool}-v${year}.4`],
      },
    },
    {
      name: "a published release holding the next number is allocated past",
      fixture: withHistory(({ previousSha }) => [
        reservedRelease({
          id: 503,
          tool,
          n: 4,
          sha: previousSha,
          draft: false,
          body: "published without a fetched tag",
        }),
      ]),
      environment,
      expected: {
        reserves: reserved(5),
        requests: ["list", `POST ${tool}-v${year}.5`],
      },
    },
    {
      name: "a Git tag ahead of every release is allocated past",
      fixture: withHistory(() => [], [[`${tool}-v${year}.7`, "previous"]]),
      environment,
      expected: {
        reserves: reserved(8),
        requests: ["list", `POST ${tool}-v${year}.8`],
      },
    },
    {
      name: "two releases reserved for this exact run are refused by id",
      fixture: withHistory(({ headSha }) => [
        ...own(504)({ headSha }),
        reservedRelease({
          id: 505,
          tool,
          n: 5,
          sha: headSha,
          body: nativeReservationMarker(tool, headSha),
        }),
      ]),
      environment,
      expected: {
        refuses: () => [
          "more than one release is reserved for this exact commit, fingerprint and intent",
          "release ids: 504 505",
        ],
        requests: ["list"],
      },
    },
    {
      name: "a published reservation tagged at another commit is refused with both commits",
      fixture: withHistory(own(506, { draft: false }), [
        [`${tool}-v${year}.4`, "previous"],
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          "the release for this run is published from a different commit",
          `tag ${tool}-v${year}.4: ${fixture.previousSha}`,
          `GITHUB_SHA: ${fixture.headSha}`,
        ],
        requests: ["list"],
      },
    },
    {
      name: "a published reservation without its Git tag is refused",
      fixture: withHistory(own(507, { draft: false })),
      environment,
      expected: {
        refuses: () => [
          "published but its Git tag does not exist",
          "release id: 507",
          `tag: ${tool}-v${year}.4`,
        ],
        requests: ["list"],
      },
    },
    {
      name: "a draft reservation whose tag already exists in Git is refused",
      fixture: withHistory(own(508), [[`${tool}-v${year}.4`, "head"]]),
      environment,
      expected: {
        refuses: (fixture) => [
          "uses a tag that already exists in Git",
          "draft release id: 508",
          `tag ${tool}-v${year}.4: ${fixture.headSha}`,
        ],
        requests: ["list"],
      },
    },
    {
      name: "a reservation renamed by hand is refused with what was found",
      fixture: withHistory(own(509, { name: "renamed" })),
      environment,
      expected: {
        refuses: (fixture) => [
          "the release reserved for this run no longer matches it",
          `expected: tag_name=${tool}-v${year}.4 name=${tool} ${year}.4 target_commitish=${fixture.headSha} prerelease=false`,
          '"name":"renamed"',
        ],
        requests: ["list"],
      },
    },
    {
      name: "a reservation sharing its tag with another release is refused with both",
      fixture: withHistory(({ headSha, previousSha }) => [
        ...own(510)({ headSha }),
        reservedRelease({
          id: 511,
          tool,
          n: 4,
          sha: previousSha,
          draft: false,
          body: "same tag",
        }),
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          "is used by 2 releases instead of 1",
          `510\t${fixture.headSha}\tdraft=true`,
          `511\t${fixture.previousSha}\tdraft=false`,
        ],
        requests: ["list"],
      },
    },
    {
      name: "an impact analysis for another commit is refused with both commits",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        IMPACT_RESULT: impactHandOff(fixture.previousSha),
      }),
      expected: {
        refuses: (fixture) => [
          "the impact analysis handed to this job does not describe this run",
          `expected: headSha=${fixture.headSha} forced=false forceReason=null`,
          `received: {"headSha":"${fixture.previousSha}","forced":false,"forceReason":null}`,
        ],
        requests: [],
      },
    },
    {
      name: "an impact analysis that is not JSON is refused",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        IMPACT_RESULT: '{"headSha":',
      }),
      expected: {
        refuses: () => ["does not describe this run", "received: jq: "],
        requests: [],
      },
    },
    {
      name: "a force state that is not a boolean is refused",
      fixture: history,
      environment: (fixture) => ({ ...environment(fixture), FORCED: "yes" }),
      expected: {
        refuses: () => ["neither true nor false", "FORCED: yes"],
        requests: [],
      },
    },
    {
      name: "a malformed fingerprint is refused",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        EXPECTED_FINGERPRINT: "not-a-fingerprint",
      }),
      expected: {
        refuses: () => [
          "not 64 lowercase hexadecimal characters",
          "EXPECTED_FINGERPRINT: not-a-fingerprint",
        ],
        requests: [],
      },
    },
    {
      name: "a checkout of another commit is refused with both commits",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        GITHUB_SHA: fixture.previousSha,
        IMPACT_RESULT: impactHandOff(fixture.previousSha),
      }),
      expected: {
        refuses: (fixture) => [
          "checked out a different commit than the one the run was started for",
          `checked out: ${fixture.headSha}`,
          `GITHUB_SHA:  ${fixture.previousSha}`,
        ],
        requests: [],
      },
    },
    {
      name: "a forced release reserves under an intent named after the run",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        FORCED: "true",
        IMPACT_RESULT: impactHandOff(fixture.headSha, true, "signing fix"),
      }),
      expected: {
        intent: "forced-4242",
        reserves: reserved(4),
        requests: ["list", `POST ${tool}-v${year}.4`],
      },
    },
    {
      name: "a forced release with a blank reason is refused",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        FORCED: "true",
        IMPACT_RESULT: JSON.stringify({
          headSha: fixture.headSha,
          forced: true,
          forceReason: "   ",
        }),
      }),
      expected: {
        refuses: () => [
          "does not describe this run",
          "forced=true forceReason=a non-blank string",
          '"forceReason":"   "',
        ],
        requests: [],
      },
    },
    {
      name: "an unreadable release inventory fails with the command named and reserves nothing",
      fixture: {
        ...history,
        events: [
          {
            on: "list",
            nth: 1,
            fail: "gh: No server is currently available to service your request. (HTTP 503)",
          },
        ],
      },
      environment,
      expected: {
        fails: () => [
          "The step stopped with exit status 1 at the command that ends at line ",
          "jq 'flatten' > \"$releases_file\"",
          "This is a command that failed, not a refusal",
        ],
        log: ["(HTTP 503)"],
        requests: ["list"],
      },
    },
    {
      name: "a reservation GitHub rejects fails with the command named",
      fixture: {
        ...history,
        events: [
          { on: "create", nth: 1, fail: "gh: Validation Failed (HTTP 422)" },
        ],
      },
      environment,
      expected: {
        fails: () => [
          "The step stopped with exit status 1 at the command that ends at line ",
          'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
        ],
        log: ["(HTTP 422)"],
        requests: ["list", `POST ${tool}-v${year}.4`],
      },
    },
    {
      name: "a reservation GitHub answers with another release is refused with both",
      fixture: { ...history, createOverride: { draft: false } },
      environment,
      expected: {
        refuses: () => [
          "does not match what was asked for",
          "draft=true prerelease=false",
          '"draft":false',
        ],
        requests: ["list", `POST ${tool}-v${year}.4`],
      },
    },
  ];
}

const NATIVE_RESERVATION_STEP = "Reserve or reuse exact draft release";
const nativeReservationFile = ".github/workflows/srn-home-server.yml";

for (const scenario of nativeReservationScenarios("srn-home-server")) {
  test(`srn-home-server reservation: ${scenario.name}`, reservationRuns, () => {
    assertReservation(
      reservationRunBlock(nativeReservationFile, NATIVE_RESERVATION_STEP),
      { ...scenario, ...nativeReservation("srn-home-server") },
    );
  });
}

// The other four native publishers carry the same script; the cases above
// stand for them for as long as that stays true.
test("every native publisher reserves with the script exercised for srn-home-server", () => {
  const exercised = reservationRunBlock(
    nativeReservationFile,
    NATIVE_RESERVATION_STEP,
  );
  assert.equal(exercised.includes("${{"), false);
  for (const tool of ["srn-admin", "srn-client", "srn-mcp", "srn-server"]) {
    assert.equal(
      reservationRunBlock(
        `.github/workflows/${tool}.yml`,
        NATIVE_RESERVATION_STEP,
      ),
      exercised,
      `${tool} reserves with a different script and needs its own cases`,
    );
  }
});

// Each of them still runs its own copy under its own name on every path
// that succeeds today, and on the refusal that stopped srn-home-server.
for (const tool of ["srn-admin", "srn-client", "srn-mcp", "srn-server"]) {
  const scenarios = nativeReservationScenarios(tool).filter(
    ({ expected, name }) =>
      (expected.reserves ?? expected.reuses) !== undefined ||
      name.startsWith("a draft reserved for another commit is refused"),
  );
  assert.equal(scenarios.length, 9);
  for (const scenario of scenarios) {
    test(`${tool} reservation: ${scenario.name}`, reservationRuns, () => {
      assertReservation(
        reservationRunBlock(
          `.github/workflows/${tool}.yml`,
          NATIVE_RESERVATION_STEP,
        ),
        { ...scenario, ...nativeReservation(tool) },
      );
    });
  }
}

function desktopReservationScenarios() {
  const tool = "srn-desktop";
  const year = RESERVATION_YEAR;
  const environment = (fixture) => ({
    TOOL: tool,
    FORCED: "false",
    IMPACT_RESULT: impactHandOff(fixture.headSha),
  });
  const history = publishedReservationHistory(tool, [1, 2, 3, 4, 5]);
  const withHistory = (extra, extraTags = []) => ({
    releases: (shas) => [...extra(shas), ...history.releases(shas)],
    tags: [...history.tags, ...extraTags],
  });
  const reserved = (overrides = {}) => ({
    version: `${year}.6`,
    app_version: `${year}.6.0`,
    tag: `${tool}-v${year}.6`,
    release_id: "900000001",
    reused: "false",
    published: "false",
    ...overrides,
  });
  const stale =
    (overrides = {}) =>
    ({ previousSha }) => [
      reservedRelease({
        id: 371520012,
        tool,
        n: 6,
        sha: previousSha,
        body: desktopReservationMarker(previousSha),
        ...overrides,
      }),
    ];
  const reconciles = [
    "list",
    "get 371520012",
    "list",
    "get 371520012",
    "DELETE 371520012",
    "list",
    `POST ${tool}-v${year}.6`,
  ];
  const removed = `Removed superseded empty automatic draft ${tool}-v${year}.6; the exact current source may now reserve that version.`;
  const notRemovable = (...found) => ({
    refuses: (fixture) => [
      "a stale srn-desktop draft is not one this job may remove",
      `this run reserves: commit=${fixture.headSha} intent=automatic`,
      "removable only if: tag srn-desktop-vYY.N",
      ...found,
      "Reconcile or delete the stale draft explicitly, then rerun. One of:",
      ...staleDraftExits(tool, 371520012, fixture.previousSha),
    ],
    requests: ["list"],
  });
  return [
    {
      name: "no release yet reserves YY.1 and its semver app version",
      fixture: {},
      environment,
      expected: {
        reserves: reserved({
          version: `${year}.1`,
          app_version: `${year}.1.0`,
          tag: `${tool}-v${year}.1`,
        }),
        requests: ["list", `POST ${tool}-v${year}.1`],
      },
    },
    {
      name: "published history reserves the next number",
      fixture: history,
      environment,
      expected: {
        reserves: reserved(),
        requests: ["list", `POST ${tool}-v${year}.6`],
      },
    },
    {
      name: "a draft for this commit and intent is reused",
      fixture: withHistory(({ headSha }) => [
        reservedRelease({
          id: 600,
          tool,
          n: 6,
          sha: headSha,
          body: desktopReservationMarker(headSha),
        }),
      ]),
      environment,
      expected: {
        reuses: reserved({ release_id: "600", reused: "true" }),
        requests: ["list"],
      },
    },
    {
      name: "a release already published from this commit is reported as published",
      fixture: withHistory(
        ({ headSha }) => [
          reservedRelease({
            id: 600,
            tool,
            n: 6,
            sha: headSha,
            draft: false,
            body: desktopReservationMarker(headSha),
          }),
        ],
        [[`${tool}-v${year}.6`, "head"]],
      ),
      environment,
      expected: {
        reuses: reserved({
          release_id: "600",
          reused: "true",
          published: "true",
        }),
        requests: ["list"],
      },
    },
    {
      name: "one empty automatic draft for another commit is removed and its number reserved",
      fixture: withHistory(stale()),
      environment,
      expected: {
        reserves: reserved(),
        requests: reconciles,
        summary: [removed],
      },
    },
    {
      name: "a stale draft holding an asset is refused with what was found",
      fixture: withHistory(stale({ assets: [{ id: 7, name: "partial.dmg" }] })),
      environment,
      expected: notRemovable('"id":371520012', '"assets":1'),
    },
    {
      name: "a stale draft from a forced run is refused",
      fixture: withHistory(({ previousSha }) => [
        reservedRelease({
          id: 371520012,
          tool,
          n: 6,
          sha: previousSha,
          body: desktopReservationMarker(previousSha, "forced-99"),
        }),
      ]),
      environment,
      expected: notRemovable("intent=forced-99"),
    },
    {
      name: "a stale draft written by a person is refused",
      fixture: withHistory(
        stale({ author: { login: "someone", id: 5, type: "User" } }),
      ),
      environment,
      expected: notRemovable('"login":"someone"'),
    },
    {
      name: "a stale immutable draft is refused",
      fixture: withHistory(stale({ immutable: true })),
      environment,
      expected: notRemovable('"immutable":true'),
    },
    {
      name: "a stale draft whose tag exists in Git is refused",
      fixture: withHistory(stale(), [[`${tool}-v${year}.6`, "previous"]]),
      environment,
      expected: {
        refuses: (fixture) => [
          "tag exists in Git, so the draft is not removed",
          "draft release id: 371520012",
          `tag ${tool}-v${year}.6: ${fixture.previousSha}`,
        ],
        requests: ["list", "get 371520012", "list"],
      },
    },
    {
      // The state recorded on 2026-10-12: three drafts under one tag.
      name: "several stale drafts are refused and each one is named with both ways out",
      fixture: withHistory(({ previousSha }) => [
        ...stale()({ previousSha }),
        ...[
          [371790900, "e5f24d6d2694829b057cc140724fb52c55879830"],
          [371803349, "d24bf886404dbabd8f483eb93149c01d27c58b3f"],
        ].map(([id, sha]) =>
          reservedRelease({
            id,
            tool,
            n: 6,
            sha,
            body: desktopReservationMarker(sha),
          }),
        ),
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          "3 unpublished srn-desktop drafts are reserved for another commit or intent",
          `this run reserves: commit=${fixture.headSha} intent=automatic`,
          `  371520012\t${tool}-v${year}.6\t${fixture.previousSha}\tcreated 2026-08-27T15:32:13Z\t0 asset(s)\t`,
          `  371790900\t${tool}-v${year}.6\te5f24d6d2694829b057cc140724fb52c55879830`,
          `  371803349\t${tool}-v${year}.6\td24bf886404dbabd8f483eb93149c01d27c58b3f`,
          "Reconcile or delete the stale drafts explicitly, then rerun. For each draft, one of:",
          ...staleDraftExits(tool, 371520012, fixture.previousSha),
          ...staleDraftExits(
            tool,
            371790900,
            "e5f24d6d2694829b057cc140724fb52c55879830",
          ),
          ...staleDraftExits(
            tool,
            371803349,
            "d24bf886404dbabd8f483eb93149c01d27c58b3f",
          ),
        ],
        requests: ["list"],
      },
    },
    {
      name: "a stale draft sharing its tag with a published release is refused",
      fixture: withHistory(({ previousSha }) => [
        reservedRelease({
          id: 371520012,
          tool,
          n: 5,
          sha: previousSha,
          body: desktopReservationMarker(previousSha),
        }),
      ]),
      environment,
      expected: {
        refuses: (fixture) => [
          "tag is used by more than one release, so the draft is not removed",
          `tag: ${tool}-v${year}.5`,
          `105\t${fixture.previousSha}\tdraft=false`,
        ],
        requests: ["list"],
      },
    },
    {
      name: "a stale draft that gains an asset before the read by id is refused with both snapshots",
      fixture: {
        ...withHistory(stale()),
        events: [
          {
            on: "get",
            nth: 1,
            patch: {
              id: 371520012,
              fields: { assets: [{ id: 9, name: "late.dmg" }] },
            },
          },
        ],
      },
      environment,
      expected: {
        refuses: () => [
          "changed between the inventory and a read by release id, so it is not removed",
          '"asset_ids":[]',
          '"asset_ids":[9]',
        ],
        requests: ["list", "get 371520012"],
      },
    },
    {
      name: "a second draft appearing under the tag during the checks is refused",
      fixture: {
        ...withHistory(stale()),
        events: ({ previousSha }) => [
          {
            on: "list",
            nth: 2,
            add: reservedRelease({
              id: 371790900,
              tool,
              n: 6,
              sha: previousSha,
              body: desktopReservationMarker(previousSha),
            }),
          },
        ],
      },
      environment,
      expected: {
        refuses: () => [
          "the release inventory changed while the stale srn-desktop draft",
          "371790900",
        ],
        requests: ["list", "get 371520012", "list"],
      },
    },
    {
      name: "a stale draft edited after its tag was checked is refused before any deletion",
      fixture: {
        ...withHistory(stale()),
        events: [
          {
            on: "get",
            nth: 2,
            patch: { id: 371520012, fields: { name: "edited" } },
          },
        ],
      },
      environment,
      expected: {
        refuses: () => [
          "changed after its tag was checked, so it is not removed",
          '"name":"edited"',
        ],
        requests: ["list", "get 371520012", "list", "get 371520012"],
      },
    },
    {
      name: "an impact analysis for another commit is refused with both commits",
      fixture: history,
      environment: (fixture) => ({
        ...environment(fixture),
        IMPACT_RESULT: impactHandOff(fixture.previousSha),
      }),
      expected: {
        refuses: (fixture) => [
          "the impact analysis handed to this job does not describe this run",
          `expected: headSha=${fixture.headSha} forced=false forceReason=null`,
          `received: {"headSha":"${fixture.previousSha}","forced":false,"forceReason":null}`,
        ],
        requests: [],
      },
    },
    {
      // load_releases is a function; a failure inside one must be reported too.
      name: "an unreadable release inventory fails with the command named and reserves nothing",
      fixture: {
        ...history,
        events: [
          {
            on: "list",
            nth: 1,
            fail: "gh: No server is currently available to service your request. (HTTP 503)",
          },
        ],
      },
      environment,
      expected: {
        fails: () => [
          "The step stopped with exit status 1 at the command that ends at line ",
          "jq 'flatten' > \"$releases_file\"",
        ],
        log: ["(HTTP 503)"],
        requests: ["list"],
      },
    },
    {
      name: "a forced release removes an empty automatic draft and reserves under its own intent",
      fixture: withHistory(stale()),
      environment: (fixture) => ({
        ...environment(fixture),
        FORCED: "true",
        IMPACT_RESULT: impactHandOff(fixture.headSha, true, "rebuild"),
      }),
      expected: {
        intent: "forced-4242",
        reserves: reserved(),
        requests: reconciles,
        summary: [removed],
      },
    },
  ];
}

for (const scenario of desktopReservationScenarios()) {
  test(`srn-desktop reservation: ${scenario.name}`, reservationRuns, () => {
    assertReservation(
      reservationRunBlock(
        ".github/workflows/srn-desktop.yml",
        "Reserve or reuse exact desktop draft",
      ),
      { ...scenario, ...desktopReservation },
    );
  });
}

// srn-desktop stopped on 2026-09-26 when its hand-off passed the size of one
// environment string. The analyzer's bound has to stay on the working side of
// that limit for the step that receives it.
test(
  "the largest hand-off the analyzer may emit still starts the reservation step",
  reservationRuns,
  () => {
    assert.equal(reservationShellProblemFound, null);
    const runBlock = reservationRunBlock(
      ".github/workflows/srn-desktop.yml",
      "Reserve or reuse exact desktop draft",
    );
    const padded = (headSha, bytes) => {
      const handOff = JSON.parse(impactHandOff(headSha));
      const overhead = Buffer.byteLength(
        JSON.stringify({ ...handOff, padding: "" }),
      );
      return JSON.stringify({
        ...handOff,
        padding: "x".repeat(bytes - overhead),
      });
    };
    for (const [bytes, starts] of [
      [30000, true],
      // What srn-desktop carried at bee44c36. Linux caps one environment
      // string at 131072 bytes; other systems draw the line elsewhere.
      ...(process.platform === "linux" ? [[210104, false]] : []),
    ]) {
      const fixture = reservationFixture();
      try {
        const handOff = padded(fixture.headSha, bytes);
        assert.equal(Buffer.byteLength(handOff), bytes);
        const result = runReservationStep(fixture, runBlock, {
          TOOL: "srn-desktop",
          FORCED: "false",
          IMPACT_RESULT: handOff,
        });
        assert.equal(result.spawnError, starts ? null : "E2BIG");
        assert.equal(result.status, starts ? 0 : null, result.stderr);
        assert.equal(result.calls.length, starts ? 2 : 0);
      } finally {
        fixture.cleanup();
      }
    }
  },
);

// Desktop requires signing secrets; absent, it skips before reservation.
const DESKTOP_SIGNING_SECRET_NAMES = Object.freeze([
  "MAC_CI_KEYS",
  "MAC_CI_KEYS_PASSWORD",
  "APPLE_TEAM_ID",
  "NOTARIZE_APPLE_ID",
  "NOTARIZE_APPLE_ID_PASSWORD",
  "SM_HOST",
  "SM_API_KEY",
  "SM_CLIENT_CERT_FILE_B64",
  "SM_CLIENT_CERT_PASSWORD",
  "SM_KEYPAIR_ALIAS",
  "SM_CODE_SIGNING_CERT_SHA1_HASH",
  "SM_CLIENT_TOOLS_MSI_SHA256",
]);

test("desktop skips before reservation unless every signing secret is configured", () => {
  const file = ".github/workflows/srn-desktop.yml";
  for (const [jobName, nextJobName, fragment, replacement, expected] of [
    [
      "signing",
      "identity",
      "          HAS_SM_API_KEY: ${{ secrets.SM_API_KEY != '' }}\n",
      "",
      [
        /missing presence-only read of SM_API_KEY/,
        /the signing check may read only whether each signing secret is set, never a value/,
      ],
    ],
    [
      "signing",
      "identity",
      "HAS_SM_API_KEY: ${{ secrets.SM_API_KEY != '' }}",
      "HAS_SM_API_KEY: ${{ secrets.SM_API_KEY }}",
      [
        /missing presence-only read of SM_API_KEY/,
        /the signing check may read only whether each signing secret is set, never a value/,
      ],
    ],
    [
      "signing",
      "identity",
      "            SM_HOST\n",
      "",
      [/missing SM_HOST among the required signing secrets/],
    ],
    [
      "signing",
      "identity",
      'echo "configured=false" >> "$GITHUB_OUTPUT"',
      "exit 1",
      [
        /missing unconfigured signing result/,
        /a missing signing secret must skip the release, not fail the run/,
      ],
    ],
    [
      "signing",
      "identity",
      'echo "::${level} title=${TOOL} release skipped::${message}.',
      'echo "${message}.',
      [/missing skipped desktop release annotation/],
    ],
    [
      "signing",
      "identity",
      "level=notice",
      "level=error",
      [/missing notice when no signing secret is configured/],
    ],
    [
      "signing",
      "identity",
      "    environment: release-production\n",
      "",
      [
        /missing signing protected production environment/,
        /desktop production environment must be scoped exactly to the signing check, identity, authenticated build, unchanged-draft deletion, and release/,
      ],
    ],
    [
      "signing",
      "identity",
      "    environment: release-production\n",
      "    environment: release-production\n    permissions:\n      contents: write\n",
      [/the signing check must not write, call GitHub, or run an action/],
    ],
    [
      "identity",
      "build",
      "needs: [impact, signing]",
      "needs: impact",
      [
        /missing desktop identity dependency on impact analysis and the signing check/,
        /identity dependencies must be exactly impact, signing; found impact/,
      ],
    ],
    [
      "identity",
      "build",
      " && needs.signing.outputs.configured == 'true'",
      "",
      [/missing desktop identity source-impact and signing-credential guard/],
    ],
    [
      "build",
      "decide",
      "CSC_LINK: ${{ secrets.MAC_CI_KEYS }}",
      "CSC_LINK: ${{ secrets.MAC_CI_KEYS_V2 }}",
      [
        /the signing check must cover exactly the secrets the workflow uses; unchecked=MAC_CI_KEYS_V2; unused=none/,
      ],
    ],
  ]) {
    const files = withJobChanged(file, jobName, nextJobName, (job) =>
      job.replace(fragment, replacement),
    );
    const errors = validateReleaseContract(files).join("\n");
    for (const pattern of expected) {
      assert.match(errors, pattern, `${jobName}: ${fragment}`);
    }
  }

  const withoutGate = withFileChanged(file, (content) => {
    const start = content.indexOf("\n  signing:");
    const end = content.indexOf("\n  identity:", start);
    return `${content.slice(0, start)}${content.slice(end)}`;
  });
  assert.match(
    validateReleaseContract(withoutGate).join("\n"),
    /missing desktop signing-credential check before reservation/,
  );
});

test("the desktop signing requirement stays documented", () => {
  const file = "docs/releases-and-upgrades.md";
  const files = withFileChanged(file, (content) =>
    content
      .replace("Its `signing` job runs before any", "A job runs before any")
      .replace(
        "Desktop publication is therefore off until the secrets exist",
        "Desktop publication may be off",
      )
      .replace("`SM_KEYPAIR_ALIAS`", "a key pair alias"),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /releases-and-upgrades\.md: missing documented desktop signing check before reservation/,
  );
  assert.match(
    errors,
    /releases-and-upgrades\.md: missing documented desktop skip without signing secrets/,
  );
  assert.match(
    errors,
    /releases-and-upgrades\.md: missing documented desktop signing secret SM_KEYPAIR_ALIAS/,
  );
});

function runDesktopSigningCheck(presence) {
  assert.equal(reservationShellProblemFound, null);
  const root = mkdtempSync(path.join(os.tmpdir(), "srn-signing-"));
  try {
    const script = path.join(root, "step.sh");
    const output = path.join(root, "github-output.txt");
    const summary = path.join(root, "github-step-summary.md");
    writeFileSync(
      script,
      reservationRunBlock(
        ".github/workflows/srn-desktop.yml",
        "Skip the release unless every signing credential is configured",
      ),
    );
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", script],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          TOOL: "srn-desktop",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          ...presence,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputText: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const desktopSigningPresence = (configured) =>
  Object.fromEntries(
    DESKTOP_SIGNING_SECRET_NAMES.map((name) => [
      `HAS_${name}`,
      String(configured(name)),
    ]),
  );
const desktopSigningSkipped = (missing) =>
  `desktop release skipped: signing secrets not configured (${missing.length} of 12 missing): ${missing.join(", ")}`;
const desktopSigningSkippedSummary = (missing) =>
  [
    "### srn-desktop release skipped",
    "",
    `${desktopSigningSkipped(missing)}.`,
    "",
    "Nothing was reserved or built, and no draft release was created. Desktop installers are only published signed and notarized. Add the missing secrets to the repository or to its `release-production` environment and the next run publishes; no workflow change is needed.",
    "",
  ].join("\n");

test(
  "srn-desktop signing check: with no signing secret the release is skipped green and all twelve are named",
  reservationRuns,
  () => {
    const result = runDesktopSigningCheck(desktopSigningPresence(() => false));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputText, "configured=false\n");
    assert.equal(
      result.stdout,
      `::notice title=srn-desktop release skipped::${desktopSigningSkipped(DESKTOP_SIGNING_SECRET_NAMES)}. Nothing was reserved or built. Add the missing secrets to the repository or to its release-production environment and the next run publishes.\n`,
    );
    assert.equal(result.stderr, "");
    assert.equal(
      result.summary,
      desktopSigningSkippedSummary(DESKTOP_SIGNING_SECRET_NAMES),
    );
  },
);

test(
  "srn-desktop signing check: with every signing secret the release proceeds and nothing is announced",
  reservationRuns,
  () => {
    const result = runDesktopSigningCheck(desktopSigningPresence(() => true));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputText, "configured=true\n");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(
      result.summary,
      "All 12 desktop signing secrets are configured; the release proceeds.\n",
    );
  },
);

test(
  "srn-desktop signing check: with only some signing secrets the release is skipped green with a warning naming the rest",
  reservationRuns,
  () => {
    const missing = DESKTOP_SIGNING_SECRET_NAMES.filter((name) =>
      name.startsWith("SM_"),
    );
    const result = runDesktopSigningCheck(
      desktopSigningPresence((name) => !name.startsWith("SM_")),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputText, "configured=false\n");
    assert.equal(
      result.stdout,
      `::warning title=srn-desktop release skipped::${desktopSigningSkipped(missing)}. Nothing was reserved or built. Add the missing secrets to the repository or to its release-production environment and the next run publishes.\n`,
    );
    assert.equal(result.summary, desktopSigningSkippedSummary(missing));
  },
);

test(
  "srn-desktop signing check: a presence value that is not a boolean fails instead of guessing",
  reservationRuns,
  () => {
    for (const presence of [
      { ...desktopSigningPresence(() => true), HAS_SM_HOST: "" },
      Object.fromEntries(
        Object.entries(desktopSigningPresence(() => true)).filter(
          ([name]) => name !== "HAS_SM_HOST",
        ),
      ),
    ]) {
      const result = runDesktopSigningCheck(presence);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.outputText, "");
      assert.equal(result.summary, "");
      assert.equal(
        result.stdout,
        "::error title=srn-desktop signing check failed::HAS_SM_HOST is '', neither true nor false; the workflow does not report whether secret SM_HOST is configured.\n",
      );
    }
  },
);
