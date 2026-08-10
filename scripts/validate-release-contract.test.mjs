import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("the Yarn-normalized OpenClaw manifest still satisfies the contract", () => {
  // `yarn install` rewrites the workspace manifest: `private: false` is dropped
  // because it is Yarn's default, and the single-entry `bin` map collapses to a
  // bare string. Both forms declare the same release package.
  const files = withOpenClawPackage((packageJson) => {
    delete packageJson.private;
    packageJson.bin = "dist/index.js";
  });

  assert.deepEqual(validateReleaseContract(files), []);
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
    content.replace('    "@electron/asar": "3.4.1",\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing exact direct @electron\/asar 3\.4\.1 devDependency/,
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
  const files = withFileChanged(
    file,
    (content) =>
      `${content}\n# accidental publisher\ngh release create bad-tag\n`,
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /normal CI impact reporting must not publish releases \(gh release create\)/,
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
    /normal CI impact reporting must not publish releases \(contents: write\)/,
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
