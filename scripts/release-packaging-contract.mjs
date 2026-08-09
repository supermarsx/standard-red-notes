#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fingerprintReleaseTree } from "./fingerprint-release-tree.mjs";

const PACKAGING_FINGERPRINT_SCHEMA = "srn-release-packaging-contract-v1";

export const RELEASE_PACKAGING_CONTRACTS = Object.freeze({
  "native-cli": Object.freeze({
    schemaVersion: 1,
    artifactKind: "native-single-file-executable",
    buildRuntime: "node26",
    embeddedRuntime: "node24",
    actions: Object.freeze({
      checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      setupNode: "820762786026740c76f36085b0efc47a31fe5020",
      uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    }),
    actionVersions: Object.freeze({
      checkout: "v7.0.1",
      downloadArtifact: "v8.0.1",
      setupNode: "v7.0.0",
      uploadArtifact: "v7.0.1",
    }),
    packager: Object.freeze({
      flags: Object.freeze(["--no-signature", "--fallback-to-source"]),
      name: "@yao-pkg/pkg",
      version: "6.21.0",
    }),
    products: Object.freeze({
      "srn-home-server": Object.freeze({
        supplementalArtifacts: Object.freeze([
          Object.freeze({
            executable: "zip",
            flags: Object.freeze(["-qr"]),
            format: "zip",
            input: "migrations",
            output: "srn-home-server-migrations.zip",
          }),
        ]),
      }),
    }),
    targets: Object.freeze([
      Object.freeze({ output: "windows-x64.exe", target: "win-x64" }),
      Object.freeze({ output: "windows-arm64.exe", target: "win-arm64" }),
      Object.freeze({ output: "macos-x64", target: "macos-x64" }),
      Object.freeze({ output: "macos-arm64", target: "macos-arm64" }),
      Object.freeze({ output: "linux-x64", target: "linux-x64" }),
      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),
    ]),
  }),
  desktop: Object.freeze({
    schemaVersion: 1,
    artifactKind: "electron-installers-and-update-metadata",
    actions: Object.freeze({
      cache: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      setupLxd: "a3c85fc6fb7fff43fcfeae87659e41a8f635b7dd",
      setupNode: "820762786026740c76f36085b0efc47a31fe5020",
      setupPython: "ece7cb06caefa5fff74198d8649806c4678c61a1",
      uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    }),
    actionVersions: Object.freeze({
      cache: "v6.1.0",
      checkout: "v7.0.1",
      downloadArtifact: "v8.0.1",
      setupLxd: "v0.1.3",
      setupNode: "v7.0.0",
      setupPython: "v6.3.0",
      uploadArtifact: "v7.0.1",
    }),
    builderCommand: "yarn electron-builder",
    builderFixedArguments: Object.freeze([
      "--publish",
      "never",
      "-c.extraMetadata.version=<normalized-release-version>",
    ]),
    corepackVersion: "0.35.0",
    deterministicInputs: Object.freeze([
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/.yarn/patches",
      "app/.yarn/releases",
      "app/babel.config.js",
      "app/tsconfig.base.json",
      "app/packages/desktop/package.json",
      "app/packages/desktop/app/package.json",
    ]),
    nodeVersionFile: "app/.nvmrc",
    rootPythonVersion: "3.14.6",
    rootLegs: Object.freeze([
      Object.freeze({
        builderArguments: "--mac dmg zip --x64 --arm64",
        platform: "macos",
        runner: "macos-latest",
      }),
      Object.freeze({
        builderArguments: "--win nsis --x64 --arm64",
        platform: "windows",
        runner: "windows-latest",
      }),
      Object.freeze({
        builderArguments: "--linux AppImage deb --x64",
        platform: "linux-x64",
        runner: "ubuntu-latest",
      }),
      Object.freeze({
        builderArguments: "--linux AppImage deb --arm64",
        platform: "linux-arm64",
        runner: "ubuntu-24.04-arm",
      }),
    ]),
    rootRunners: Object.freeze([
      "macos-latest",
      "windows-latest",
      "ubuntu-latest",
      "ubuntu-24.04-arm",
    ]),
    rootTargets: Object.freeze([
      "--mac dmg zip --x64 --arm64",
      "--win nsis --x64 --arm64",
      "--linux AppImage deb --x64",
      "--linux AppImage deb --arm64",
    ]),
    standaloneArtifactFanInPattern: "explicit-five-artifact-downloads",
    standalonePythonVersion: "3.10",
    standaloneBuilderCommand: "yarn run electron-builder",
    standaloneBuilderFixedArguments: Object.freeze([
      "--publish=never",
      "--c.extraMetadata.version=<app-version>",
    ]),
    standalonePublicationCommands: Object.freeze([
      'gh release upload "$RELEASE_TAG" "${files[@]}" --clobber',
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${release_id}"',
      'snapcraft revisions "$snap_name" --arch "$snap_arch"',
      'snapcraft upload "$snap_file" --release stable,candidate,beta,edge',
    ]),
    semanticPublicationGraphs: Object.freeze({
      root: Object.freeze({
        "artifact-build": Object.freeze(["release-identity"]),
        "artifact-fan-in": Object.freeze([
          "artifact-build",
          "release-decision",
          "release-identity",
        ]),
        "draft-discard": Object.freeze([
          "impact-analysis",
          "release-decision",
          "release-identity",
        ]),
        "github-publish": Object.freeze([
          "artifact-build",
          "artifact-fan-in",
          "impact-analysis",
          "release-decision",
          "release-identity",
        ]),
        "release-decision": Object.freeze([
          "artifact-build",
          "impact-analysis",
          "release-identity",
        ]),
        "release-identity": Object.freeze(["impact-analysis"]),
      }),
      standalone: Object.freeze({
        "artifact-fan-in": Object.freeze([
          "deb-arm64-validation",
          "deb-x64-validation",
          "linux-appimage-arm64",
          "linux-appimage-x64",
          "linux-dir-arm64",
          "linux-dir-x64",
          "linux-snap",
          "mac-build",
          "windows-build",
        ]),
        "deb-arm64-validation": Object.freeze(["linux-appimage-arm64"]),
        "deb-x64-validation": Object.freeze(["linux-appimage-x64"]),
        "github-publish": Object.freeze(["artifact-fan-in"]),
        "release-status": Object.freeze([
          "artifact-fan-in",
          "github-publish",
          "snap-publish",
        ]),
        "snap-publish": Object.freeze(["artifact-fan-in"]),
      }),
    }),
    standaloneReleaseFiles: "payload/*",
    standaloneReleaseInventory: Object.freeze({
      authorities: Object.freeze({
        "latest-linux-arm64.yml": "dist-linux-arm64",
        "latest-linux.yml": "dist-linux-x64",
        "latest-mac.yml": "dist-macos",
        "latest.yml": "dist-windows",
      }),
      requiredTemplates: Object.freeze([
        "DESKTOP-ARTIFACTS.json",
        "SHA256SUMS",
        "latest-linux-arm64.yml",
        "latest-linux.yml",
        "latest-mac.yml",
        "latest.yml",
        "standard-red-notes-<app-version>-linux-arm64.AppImage",
        "standard-red-notes-<app-version>-linux-arm64.deb",
        "standard-red-notes-<app-version>-linux-x86_64.AppImage",
        "standard-red-notes-<app-version>-linux-amd64.deb",
        "standard-red-notes-<app-version>-mac-arm64.dmg",
        "standard-red-notes-<app-version>-mac-arm64.zip",
        "standard-red-notes-<app-version>-mac-x64.dmg",
        "standard-red-notes-<app-version>-mac-x64.zip",
        "standard-red-notes-<app-version>-win-arm64.exe",
        "standard-red-notes-<app-version>-win-x64.exe",
      ]),
      snapTemplate: "standard-red-notes-<app-version>-linux-*.snap",
    }),
    standaloneTargets: Object.freeze([
      Object.freeze({
        artifactGlobs: Object.freeze([
          "packages/desktop/dist/*.dmg",
          "packages/desktop/dist/*.zip",
          "packages/desktop/dist/*.blockmap",
          "packages/desktop/dist/*.yml",
        ]),
        artifactName: "dist-macos",
        builderArguments: Object.freeze(["--mac dmg zip --x64 --arm64"]),
        job: "Mac",
        requiredEnvironment: Object.freeze([]),
        runner: "macos-latest",
        validationCommands: Object.freeze(["test -s dist/latest-mac.yml"]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([
          "packages/desktop/dist/*.exe",
          "packages/desktop/dist/*.blockmap",
          "packages/desktop/dist/*.yml",
        ]),
        artifactName: "dist-windows",
        builderArguments: Object.freeze(["--win nsis --x64 --arm64"]),
        job: "Windows",
        requiredEnvironment: Object.freeze([]),
        runner: "windows-latest",
        validationCommands: Object.freeze([]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([
          "packages/desktop/dist/*.AppImage",
          "packages/desktop/dist/*.deb",
          "packages/desktop/dist/*.blockmap",
          "packages/desktop/dist/*.yml",
        ]),
        artifactName: "dist-linux-x64",
        builderArguments: Object.freeze(["--linux AppImage deb --x64"]),
        job: "Linux-AppImage-X64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-latest",
        validationCommands: Object.freeze([]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([
          "packages/desktop/dist/*.AppImage",
          "packages/desktop/dist/*.deb",
          "packages/desktop/dist/*.blockmap",
          "packages/desktop/dist/*.yml",
        ]),
        artifactName: "dist-linux-arm64",
        builderArguments: Object.freeze(["--linux AppImage deb --arm64"]),
        job: "Linux-AppImage-ARM64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-24.04-arm",
        validationCommands: Object.freeze([]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([]),
        artifactName: null,
        builderArguments: Object.freeze(["--linux --x64 -c.linux.target=dir"]),
        job: "Linux-Dir-X64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-latest",
        validationCommands: Object.freeze([]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([]),
        artifactName: null,
        builderArguments: Object.freeze([
          "--linux --arm64 -c.linux.target=dir",
        ]),
        job: "Linux-Dir-ARM64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-24.04-arm",
        validationCommands: Object.freeze([]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([]),
        artifactName: null,
        builderArguments: Object.freeze([]),
        job: "Linux-Deb-X64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-latest",
        validationCommands: Object.freeze([
          'test "$(dpkg-deb --field "${packages[0]}" Architecture)" = amd64',
        ]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze([]),
        artifactName: null,
        builderArguments: Object.freeze([]),
        job: "Linux-Deb-ARM64",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-24.04-arm",
        validationCommands: Object.freeze([
          'test "$(dpkg-deb --field "${packages[0]}" Architecture)" = arm64',
        ]),
      }),
      Object.freeze({
        artifactGlobs: Object.freeze(["packages/desktop/dist/*.snap"]),
        artifactName: "dist-linux-snap",
        builderArguments: Object.freeze(["--linux --x64 -c.linux.target=snap"]),
        job: "Linux-Snap",
        requiredEnvironment: Object.freeze([]),
        runner: "ubuntu-latest",
        validationCommands: Object.freeze([
          'review-tools.snap-review "${snaps[0]}"',
        ]),
      }),
    ]),
    rootReleaseInventory: Object.freeze({
      authorities: Object.freeze({
        "latest-linux-arm64.yml": "linux-arm64",
        "latest-linux.yml": "linux-x64",
        "latest-mac.yml": "macos",
        "latest.yml": "windows",
      }),
      requiredTemplates: Object.freeze([
        "DESKTOP-ARTIFACTS.json",
        "SHA256SUMS.txt",
        "latest-linux-arm64.yml",
        "latest-linux.yml",
        "latest-mac.yml",
        "latest.yml",
        "standard-red-notes-<app-version>-linux-arm64.AppImage",
        "standard-red-notes-<app-version>-linux-arm64.deb",
        "standard-red-notes-<app-version>-linux-x86_64.AppImage",
        "standard-red-notes-<app-version>-linux-amd64.deb",
        "standard-red-notes-<app-version>-mac-arm64.dmg",
        "standard-red-notes-<app-version>-mac-arm64.zip",
        "standard-red-notes-<app-version>-mac-x64.dmg",
        "standard-red-notes-<app-version>-mac-x64.zip",
        "standard-red-notes-<app-version>-win-arm64.exe",
        "standard-red-notes-<app-version>-win-x64.exe",
        "srn-desktop-linux-arm64.fingerprint",
        "srn-desktop-linux-x64.fingerprint",
        "srn-desktop-macos-arm64.fingerprint",
        "srn-desktop-macos-x64.fingerprint",
        "srn-desktop-windows-arm64.fingerprint",
        "srn-desktop-windows-x64.fingerprint",
      ]),
    }),
    signingIdentityAutoDiscovery: false,
    toolchainMetadata: Object.freeze([
      "builderArguments",
      "electronBuilderVersion",
      "electronVersion",
      "nodeVersion",
    ]),
  }),
  mobile: Object.freeze({
    schemaVersion: 1,
    artifactKind: "signed-android-and-ios-apps",
    actions: Object.freeze({
      cache: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      setupJava: "0f481fcb613427c0f801b606911222b5b6f3083a",
      setupNode: "820762786026740c76f36085b0efc47a31fe5020",
      setupRuby: "003a5c4d8d6321bd302e38f6f0ec593f77f06600",
      setupXcode: "ed7a3b1fda3918c0306d1b724322adc0b8cc0a90",
      uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    }),
    actionVersions: Object.freeze({
      cache: "v6.1.0",
      checkout: "v7.0.1",
      downloadArtifact: "v8.0.1",
      setupJava: "v5.5.0",
      setupNode: "v7.0.0",
      setupRuby: "v1.319.0",
      setupXcode: "v1.7.0",
      uploadArtifact: "v7.0.1",
    }),
    androidArchitectures: Object.freeze([
      "armeabi-v7a",
      "arm64-v8a",
      "x86",
      "x86_64",
    ]),
    buildCommands: Object.freeze([
      "bundle exec fastlane android build_prod",
      "bundle exec fastlane ios setup",
      "bundle exec fastlane ios build_prod",
    ]),
    corepackVersion: "0.35.0",
    deterministicInputs: Object.freeze([
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/.yarn/patches",
      "app/.yarn/releases",
      "app/babel.config.js",
      "app/tsconfig.base.json",
      "app/packages/mobile/Gemfile",
      "app/packages/mobile/Gemfile.lock",
      "app/packages/mobile/.java-version",
      "app/packages/mobile/.ruby-version",
      "app/packages/mobile/app.json",
      "app/packages/mobile/babel.config.js",
      "app/packages/mobile/metro.config.js",
      "app/packages/mobile/react-native.config.js",
      "app/packages/mobile/fastlane/Appfile",
      "app/packages/mobile/fastlane/Fastfile",
      "app/packages/mobile/fastlane/Matchfile",
      "app/packages/mobile/fastlane/Pluginfile",
    ]),
    iosArchitectures: Object.freeze(["arm64"]),
    applicationIdentity: Object.freeze({
      androidApplicationId: "com.standardnotes",
      androidVersionCodeBase: 3004000,
      iosAppGroup: "group.com.standardnotes.standardnotes",
      iosBundleIdentifier: "com.standardnotes.standardnotes",
      iosShareExtensionIdentifier:
        "com.standardnotes.standardnotes.Share-To-SN",
      iosTeamIdentifier: "HKF9BXSN95",
    }),
    credentialContracts: Object.freeze({
      androidUploadCertificateSecret: "EXPECTED_ANDROID_UPLOAD_CERT_SHA256",
      iosExportComplianceCodeSecret: "IOS_EXPORT_COMPLIANCE_CODE",
      iosUsesNonExemptEncryptionVariable: "IOS_USES_NON_EXEMPT_ENCRYPTION",
    }),
    iosArtifactIdentity: Object.freeze([
      "CFBundleShortVersionString",
      "CFBundleVersion",
    ]),
    javaDistribution: "zulu",
    javaVersion: "17",
    nodeVersionFile: "app/.nvmrc",
    payloads: Object.freeze([
      "android-release-bundle",
      "ios-release-bundle",
      "embedded-web",
      "native-android-source",
      "native-ios-source",
    ]),
    publicationCommands: Object.freeze([
      "bundle exec fastlane android publish_prod",
      "bundle exec fastlane ios upload_prod",
      "bundle exec fastlane ios distribute_prod",
      "bundle exec fastlane ios submit_prod",
    ]),
    productionEnvironment: "mobile-production",
    providerInspectionLanes: Object.freeze([
      "bundle exec fastlane android inspect_prod",
      "bundle exec fastlane ios inspect_upload",
      "bundle exec fastlane ios inspect_distribution",
      "bundle exec fastlane ios inspect_submission",
    ]),
    recoveryIntentArtifacts: Object.freeze([
      "srn-mobile-google-play-intent-<run-id>",
      "srn-mobile-app-store-intent-<run-id>",
      "srn-mobile-testflight-distribution-intent-<run-id>",
      "srn-mobile-app-store-submission-intent-<run-id>",
    ]),
    releaseReservationMarker:
      "srn-mobile-release-intent:run=<run-id>;sha=<source-commit>;version=<version>;fingerprint=<fingerprint>",
    retentionDays: 30,
    buildLegs: Object.freeze([
      Object.freeze({ platform: "android", runner: "ubuntu-latest" }),
      Object.freeze({ platform: "ios", runner: "macos-15" }),
    ]),
    publicationTopology: Object.freeze({
      buildJobs: Object.freeze(["android", "ios"]),
      crossStoreTransaction: false,
      githubReleaseAfter: Object.freeze(["publish_android", "submit_ios"]),
      iosPublicationSequence: Object.freeze([
        "upload_ios",
        "distribute_ios",
        "submit_ios",
      ]),
      publishJobs: Object.freeze([
        "publish_android",
        "upload_ios",
        "distribute_ios",
        "submit_ios",
      ]),
      validatedArtifact: "srn-mobile-validated-release",
      validationFanInJob: "validated",
    }),
    semanticPublicationGraphs: Object.freeze({
      root: Object.freeze({
        "impact-analysis": Object.freeze([]),
        "release-version": Object.freeze(["impact-analysis"]),
        "release-fingerprint": Object.freeze(["release-version"]),
        "release-decision": Object.freeze([
          "impact-analysis",
          "release-fingerprint",
        ]),
        "github-draft-reservation": Object.freeze([
          "release-version",
          "release-fingerprint",
          "release-decision",
        ]),
        "android-build": Object.freeze([
          "release-version",
          "release-decision",
          "github-draft-reservation",
        ]),
        "ios-build": Object.freeze([
          "release-version",
          "release-decision",
          "github-draft-reservation",
        ]),
        "validated-android-ios": Object.freeze([
          "release-version",
          "release-decision",
          "release-fingerprint",
          "android-build",
          "ios-build",
        ]),
        "android-store-publish": Object.freeze([
          "release-version",
          "release-decision",
          "validated-android-ios",
        ]),
        "ios-app-store-upload": Object.freeze([
          "release-version",
          "release-decision",
          "validated-android-ios",
        ]),
        "ios-review-distribute": Object.freeze([
          "release-version",
          "release-decision",
          "validated-android-ios",
          "ios-app-store-upload",
        ]),
        "ios-review-submit": Object.freeze([
          "release-version",
          "release-decision",
          "validated-android-ios",
          "ios-review-distribute",
        ]),
        "github-release": Object.freeze([
          "release-version",
          "release-decision",
          "validated-android-ios",
          "android-store-publish",
          "ios-review-submit",
        ]),
      }),
      standalone: Object.freeze({
        "release-context-and-reservation": Object.freeze([]),
        "android-build": Object.freeze(["release-context-and-reservation"]),
        "ios-build": Object.freeze(["release-context-and-reservation"]),
        "validated-android-ios": Object.freeze([
          "release-context-and-reservation",
          "android-build",
          "ios-build",
        ]),
        "android-store-publish": Object.freeze([
          "release-context-and-reservation",
          "validated-android-ios",
        ]),
        "ios-app-store-upload": Object.freeze([
          "release-context-and-reservation",
          "validated-android-ios",
        ]),
        "ios-review-distribute": Object.freeze([
          "release-context-and-reservation",
          "validated-android-ios",
          "ios-app-store-upload",
        ]),
        "ios-review-submit": Object.freeze([
          "release-context-and-reservation",
          "validated-android-ios",
          "ios-review-distribute",
        ]),
        "github-release": Object.freeze([
          "release-context-and-reservation",
          "validated-android-ios",
          "android-store-publish",
          "ios-review-submit",
        ]),
      }),
    }),
    validatedReleaseTemplates: Object.freeze([
      "standard-red-notes-android-universal-<version>.apk",
      "standard-red-notes-android-<version>.aab",
      "standard-red-notes-ios-arm64-<version>.ipa",
      "standard-red-notes-mobile-identity.json",
      "srn-mobile.fingerprint",
      "SHA256SUMS.txt",
    ]),
    rubyVersion: "3.4.7",
    runners: Object.freeze(["ubuntu-latest", "macos-15"]),
    xcodeVersion: "26",
  }),
  openclaw: Object.freeze({
    schemaVersion: 1,
    artifactKind: "platform-neutral-npm-tarball",
    actions: Object.freeze({
      attestBuildProvenance: "0f67c3f4856b2e3261c31976d6725780e5e4c373",
      checkout: "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      setupNode: "820762786026740c76f36085b0efc47a31fe5020",
      uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    }),
    actionVersions: Object.freeze({
      attestBuildProvenance: "v4.1.1",
      checkout: "v7.0.0",
      downloadArtifact: "v8.0.1",
      setupNode: "v7.0.0",
      uploadArtifact: "v7.0.1",
    }),
    corepackVersion: "0.35.0",
    nodeVersion: "26.5.0",
    packageManager: "yarn@4.17.1",
    provenance: Object.freeze({
      bundleFilename:
        "srn-openclaw-<package-version>-node-any.provenance.sigstore.json",
      checksumAlgorithm: "sha256",
      format: "sigstore-bundle-json",
      predicate: "slsa-build-provenance",
      verification: Object.freeze({
        repository: "github.repository",
        signerWorkflow: ".github/workflows/srn-openclaw.yml",
        sourceDigest: "release-source-commit",
      }),
      subjects: Object.freeze([
        "srn-openclaw-<package-version>-node-any.tgz",
        "srn-openclaw-<package-version>-node-any.manifest.json",
        "srn-openclaw.fingerprint",
      ]),
    }),
    releaseManifestNormalizedFields: Object.freeze([
      "/release/sourceCommit",
      "/release/sourceDate",
      "/release/tag",
      "/release/version",
    ]),
  }),
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  throw new TypeError(
    `packaging contract contains unsupported value: ${String(value)}`,
  );
}

export function semanticReleasePackagingContract(contractName, contract) {
  const semantic = structuredClone(contract);
  delete semantic.actionVersions;

  if (contractName === "desktop") {
    // These fields route already-defined payloads between jobs. Renaming a job,
    // handoff artifact, or staging glob does not alter the bytes or toolchain.
    delete semantic.standaloneArtifactFanInPattern;
    delete semantic.standaloneReleaseFiles;
    semantic.standaloneTargets = semantic.standaloneTargets.map((target) => {
      const projected = { ...target };
      delete projected.artifactGlobs;
      delete projected.artifactName;
      delete projected.job;
      return projected;
    });
  }

  if (contractName === "mobile") {
    // publicationTopology contains concrete workflow job/artifact labels. The
    // functional DAGs are retained separately as semanticPublicationGraphs.
    delete semantic.publicationTopology;
  }

  return semantic;
}

function validateMetadata(metadata, requiredNames) {
  if (!isPlainObject(metadata)) {
    throw new TypeError("packaging fingerprint metadata must be an object");
  }
  for (const name of requiredNames ?? []) {
    if (typeof metadata[name] !== "string" || metadata[name].trim() === "") {
      throw new TypeError(`packaging fingerprint requires metadata '${name}'`);
    }
  }
  for (const [name, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new TypeError(`invalid packaging metadata name: ${name}`);
    }
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
      throw new TypeError(
        `packaging metadata '${name}' must be a single-line string`,
      );
    }
  }
}

export async function fingerprintReleasePackaging({
  contractName,
  contract = RELEASE_PACKAGING_CONTRACTS[contractName],
  metadata = {},
  ...treeOptions
}) {
  if (!contract) {
    throw new TypeError(`unknown release packaging contract: ${contractName}`);
  }
  validateMetadata(metadata, contract.toolchainMetadata);
  const payloadFingerprint = await fingerprintReleaseTree(treeOptions);
  const semanticContract = semanticReleasePackagingContract(
    contractName,
    contract,
  );
  const document = {
    contract: semanticContract,
    contractName,
    metadata,
    payloadFingerprint,
    schema: PACKAGING_FINGERPRINT_SCHEMA,
  };
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

function parseArguments(argv) {
  const repeated = new Map([
    ["--exclude", []],
    ["--metadata", []],
    ["--normalize-json-field", []],
    ["--normalize-package-version", []],
    ["--path", []],
  ]);
  const single = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new TypeError(
        `expected --name value arguments; received ${argv.join(" ")}`,
      );
    }
    if (repeated.has(flag)) {
      repeated.get(flag).push(value);
    } else if (single.has(flag)) {
      throw new TypeError(`argument '${flag}' was supplied more than once`);
    } else {
      single.set(flag, value);
    }
  }
  const allowed = new Set([
    "--contract",
    "--github-output",
    "--output",
    "--root",
  ]);
  for (const flag of single.keys()) {
    if (!allowed.has(flag)) {
      throw new TypeError(`unknown argument '${flag}'`);
    }
  }
  const metadata = {};
  for (const specification of repeated.get("--metadata")) {
    const separator = specification.indexOf("=");
    if (separator <= 0) {
      throw new TypeError(`metadata must use <name>=<value>: ${specification}`);
    }
    const name = specification.slice(0, separator);
    if (Object.hasOwn(metadata, name)) {
      throw new TypeError(`metadata '${name}' was supplied more than once`);
    }
    metadata[name] = specification.slice(separator + 1);
  }
  return {
    contractName: single.get("--contract"),
    exclude: repeated.get("--exclude"),
    githubOutput: single.get("--github-output"),
    metadata,
    normalizeJsonField: repeated.get("--normalize-json-field"),
    normalizePackageVersion: repeated.get("--normalize-package-version"),
    output: single.get("--output"),
    paths: repeated.get("--path"),
    root: single.get("--root"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fingerprint = await fingerprintReleasePackaging(options);
  if (options.output) {
    writeFileSync(options.output, `${fingerprint}\n`);
  }
  if (options.githubOutput) {
    writeFileSync(options.githubOutput, `fingerprint=${fingerprint}\n`, {
      flag: "a",
    });
  }
  process.stdout.write(`${fingerprint}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `Release packaging fingerprint failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
