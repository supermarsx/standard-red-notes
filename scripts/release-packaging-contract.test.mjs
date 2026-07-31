import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fingerprintNativeCliRelease,
  nativeCliPackagePlan,
  nativeCliExecutorIdentity,
  nativeCliExecutorImplementationSource,
  packageNativeCli,
  parseNativeCliArguments,
} from "./native-cli-release.mjs";
import {
  RELEASE_PACKAGING_CONTRACTS,
  canonicalJson,
  fingerprintReleasePackaging,
} from "./release-packaging-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "srn-package-contract-"));
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "index.cjs"), "console.log('ok')\n");
  writeFileSync(
    path.join(root, "workflow.yml"),
    "# comment\npermissions: read-all\n",
  );
  return root;
}

test("canonical packaging documents do not depend on object key order", () => {
  assert.equal(
    canonicalJson({ target: "linux", flags: ["a", "b"], runtime: 24 }),
    canonicalJson({ runtime: 24, flags: ["a", "b"], target: "linux" }),
  );
});

test("native package fingerprints cover runtime, targets, flags, and action SHAs", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS["native-cli"]);
  const first = await fingerprintNativeCliRelease({
    tool: "srn-client",
    bundle: "dist/index.cjs",
    outDir: "out",
    root,
    paths: ["dist/index.cjs"],
    packagingContract: base,
  });

  for (const mutate of [
    (value) => (value.embeddedRuntime = "node26"),
    (value) =>
      value.targets.push({ output: "linux-riscv64", target: "linux-riscv64" }),
    (value) => value.packager.flags.push("--public"),
    (value) =>
      (value.actions.setupNode = "1111111111111111111111111111111111111111"),
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(
      await fingerprintNativeCliRelease({
        tool: "srn-client",
        bundle: "dist/index.cjs",
        outDir: "out",
        root,
        paths: ["dist/index.cjs"],
        packagingContract: changed,
      }),
      first,
    );
  }
});

test("native product-only packaging changes do not release sibling tools", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS["native-cli"]);
  const changed = structuredClone(base);
  changed.products["srn-home-server"].supplementalArtifacts[0].format =
    "tar.gz";
  const options = {
    bundle: "dist/index.cjs",
    outDir: "out",
    root,
    paths: ["dist/index.cjs"],
  };
  assert.equal(
    await fingerprintNativeCliRelease({
      ...options,
      tool: "srn-client",
      packagingContract: base,
    }),
    await fingerprintNativeCliRelease({
      ...options,
      tool: "srn-client",
      packagingContract: changed,
    }),
  );
  assert.notEqual(
    await fingerprintNativeCliRelease({
      ...options,
      tool: "srn-home-server",
      packagingContract: base,
    }),
    await fingerprintNativeCliRelease({
      ...options,
      tool: "srn-home-server",
      packagingContract: changed,
    }),
  );
});

test("executor-only semantic changes alter every native fingerprint", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = nativeCliExecutorImplementationSource();
  const changedSource = source.replace(
    'if (options.command === "package")',
    'if (options.command === "fingerprint")',
  );
  assert.notEqual(changedSource, source);
  const baseIdentity = nativeCliExecutorIdentity(source);
  const changedIdentity = nativeCliExecutorIdentity(changedSource);
  assert.match(baseIdentity.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(changedIdentity.sha256, baseIdentity.sha256);
  const options = {
    tool: "srn-client",
    bundle: "dist/index.cjs",
    outDir: "out",
    root,
    paths: ["dist/index.cjs"],
  };
  assert.notEqual(
    await fingerprintNativeCliRelease({
      ...options,
      executorIdentity: baseIdentity,
    }),
    await fingerprintNativeCliRelease({
      ...options,
      executorIdentity: changedIdentity,
    }),
  );
});

test("native executor identity hashes exact source bytes without grammar collisions", () => {
  const compact = "export function invoke(value) { return value + 1; }\n";
  const reformatted = `
    // Formatting and comments deliberately remain release-significant.
    export function invoke(value) {
      return value + 1;
    }
  `;
  const changed = "export function invoke(value) { return value + 2; }\n";
  const compactIdentity = nativeCliExecutorIdentity(compact);
  assert.notEqual(
    nativeCliExecutorIdentity(reformatted).sha256,
    compactIdentity.sha256,
  );
  assert.notEqual(
    nativeCliExecutorIdentity(changed).sha256,
    compactIdentity.sha256,
  );
  assert.deepEqual(compactIdentity.normalizer, {
    encoding: "utf8",
    name: "srn-js-source-bytes",
    version: "1",
  });

  const collisionRegressions = [
    ["const a = 1\nconst b = 2\n", "const a = 1 const b = 2\n"],
    ["const a = 1/*\n*/const b = 2\n", "const a = 1/**/const b = 2\n"],
    ["const a = 1e+2;\n", "const a = 1e + 2;\n"],
    [
      "function f(x){return\u2028x}\nexport { f };",
      "function f(x){return x}\nexport { f };",
    ],
    [
      "function f(x){return\u2029x}\nexport { f };",
      "function f(x){return x}\nexport { f };",
    ],
    [
      "let x=1;// comment\u2028x=2;\nexport {x};",
      "let x=1;// comment\nx=2;\nexport {x};",
    ],
    ["const x = `outer ${`//one`} end`;", "const x = `outer ${`//two`} end`;"],
    ['if (true) {} /[ ]/.test(" ");', 'if (true) {} /[]/.test(" ");'],
  ];
  for (const [left, right] of collisionRegressions) {
    assert.notEqual(
      nativeCliExecutorIdentity(left).sha256,
      nativeCliExecutorIdentity(right).sha256,
    );
  }
});

test("native release tooling resolves without a root node_modules tree", (t) => {
  const isolated = mkdtempSync(path.join(tmpdir(), "srn-native-tooling-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  for (const file of [
    "fingerprint-release-tree.mjs",
    "native-cli-release.mjs",
    "release-packaging-contract.mjs",
  ]) {
    copyFileSync(
      path.join(repositoryRoot, "scripts", file),
      path.join(isolated, file),
    );
  }
  const entry = pathToFileURL(
    path.join(isolated, "native-cli-release.mjs"),
  ).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(entry)})`],
    {
      cwd: isolated,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("desktop fixed builder flags are material packaging inputs", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS.desktop);
  const options = {
    contractName: "desktop",
    contract: base,
    metadata: {
      builderArguments: "--win nsis --x64 --arm64",
      electronBuilderVersion: "26.0.0",
      electronVersion: "39.0.0",
      nodeVersion: "v26.0.0",
    },
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging(options);
  const changed = structuredClone(base);
  changed.builderFixedArguments[1] = "onTagOrDraft";
  assert.notEqual(
    await fingerprintReleasePackaging({ ...options, contract: changed }),
    first,
  );
});

test("root and standalone desktop release surfaces are independently fingerprinted", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS.desktop);
  const options = {
    contractName: "desktop",
    metadata: {
      builderArguments: "--linux AppImage deb --x64",
      electronBuilderVersion: "26.0.0",
      electronVersion: "39.0.0",
      nodeVersion: "v26.0.0",
    },
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging({
    ...options,
    contract: base,
  });
  for (const mutate of [
    (value) => (value.rootPythonVersion = "3.15.0"),
    (value) => (value.standalonePythonVersion = "3.11"),
    (value) => (value.rootRunners[0] = "macos-16"),
    (value) => value.rootTargets.pop(),
    (value) => (value.standaloneBuilderCommand = "npx electron-builder"),
    (value) => value.standaloneBuilderFixedArguments.pop(),
    (value) => value.standalonePublicationCommands.pop(),
    (value) => (value.standaloneTargets[0].runner = "macos-16"),
    (value) => value.standaloneTargets[0].builderArguments.pop(),
    (value) => value.standaloneTargets[8].validationCommands.pop(),
    (value) => value.standaloneReleaseInventory.requiredTemplates.pop(),
    (value) => value.rootReleaseInventory.requiredTemplates.pop(),
    (value) => value.standaloneTargets.pop(),
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(
      await fingerprintReleasePackaging({ ...options, contract: changed }),
      first,
    );
  }
});

test("unchanged payload and contract skip unrelated workflow prose and permissions", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    tool: "srn-server",
    bundle: "dist/index.cjs",
    outDir: "out",
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintNativeCliRelease(options);
  writeFileSync(
    path.join(root, "workflow.yml"),
    "# rewritten prose\npermissions:\n  contents: read\n",
  );
  assert.equal(await fingerprintNativeCliRelease(options), first);
});

test("renamed or deleted packaging inputs fail closed while payload changes release", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    contractName: "native-cli",
    metadata: { tool: "srn-mcp" },
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging(options);
  writeFileSync(
    path.join(root, "dist", "index.cjs"),
    "console.log('changed')\n",
  );
  assert.notEqual(await fingerprintReleasePackaging(options), first);

  renameSync(
    path.join(root, "dist", "index.cjs"),
    path.join(root, "dist", "renamed.cjs"),
  );
  await assert.rejects(fingerprintReleasePackaging(options), /ENOENT/);
});

test("desktop and mobile material contract changes alter otherwise identical payloads", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "desktop",
      metadata: {
        builderArguments: "--linux AppImage deb --x64",
        electronBuilderVersion: "26.0.0",
        electronVersion: "39.0.0",
        nodeVersion: "v26.0.0",
      },
      mutate: (value) => (value.rootTargets[2] = "--linux AppImage rpm --x64"),
    },
    {
      name: "mobile",
      metadata: {},
      mutate: (value) => (value.actions.setupJava = "v6"),
    },
  ];
  for (const item of cases) {
    const contract = structuredClone(RELEASE_PACKAGING_CONTRACTS[item.name]);
    const options = {
      contractName: item.name,
      contract,
      metadata: item.metadata,
      root,
      paths: ["dist/index.cjs"],
    };
    const first = await fingerprintReleasePackaging(options);
    item.mutate(contract);
    assert.notEqual(await fingerprintReleasePackaging(options), first);
  }
});

test("mobile lockfiles and native package inputs are fingerprinted", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = [
    "app/yarn.lock",
    "app/packages/mobile/Gemfile.lock",
    "app/packages/mobile/fastlane/Fastfile",
    "app/packages/mobile/react-native.config.js",
  ];
  for (const input of inputs) {
    mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
    writeFileSync(path.join(root, input), `original ${input}\n`);
  }
  const options = {
    contractName: "mobile",
    root,
    paths: ["dist/index.cjs", ...inputs],
  };
  const first = await fingerprintReleasePackaging(options);
  for (const input of inputs) {
    const file = path.join(root, input);
    writeFileSync(file, `changed ${input}\n`);
    assert.notEqual(await fingerprintReleasePackaging(options), first);
    writeFileSync(file, `original ${input}\n`);
  }
});

test("mobile identity, recovery, provider, topology, and toolchain contracts are material", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS.mobile);
  const options = {
    contractName: "mobile",
    contract: base,
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging(options);
  for (const mutate of [
    (value) => (value.javaVersion = "21"),
    (value) => (value.rubyVersion = "3.5.0"),
    (value) => (value.xcodeVersion = "27"),
    (value) => (value.runners[1] = "macos-16"),
    (value) => (value.buildLegs[1].runner = "macos-16"),
    (value) => (value.applicationIdentity.androidApplicationId = "org.example"),
    (value) =>
      (value.applicationIdentity.iosBundleIdentifier = "org.example.ios"),
    (value) =>
      (value.applicationIdentity.iosShareExtensionIdentifier =
        "org.example.ios.share"),
    (value) => (value.applicationIdentity.iosTeamIdentifier = "WRONGTEAM"),
    (value) => (value.applicationIdentity.androidVersionCodeBase = 1),
    (value) => (value.applicationIdentity.iosAppGroup = "group.example"),
    (value) =>
      (value.credentialContracts.androidUploadCertificateSecret =
        "UNBOUND_CERTIFICATE"),
    (value) =>
      (value.credentialContracts.iosUsesNonExemptEncryptionVariable =
        "UNREVIEWED_EXPORT_CLASSIFICATION"),
    (value) => (value.productionEnvironment = "unprotected"),
    (value) => (value.retentionDays = 7),
    (value) => value.providerInspectionLanes.pop(),
    (value) => value.recoveryIntentArtifacts.pop(),
    (value) => (value.releaseReservationMarker = "unbound-marker"),
    (value) => value.validatedReleaseTemplates.pop(),
    (value) => (value.actions.setupJava = "v6"),
    (value) => value.androidArchitectures.push("riscv64"),
    (value) => value.iosArtifactIdentity.pop(),
    (value) => (value.buildCommands[0] = "fastlane android unsafe_build"),
    (value) =>
      (value.publicationCommands[0] = "fastlane android unsafe_publish"),
    (value) => (value.publicationCommands[1] = "fastlane ios unsafe_upload"),
    (value) =>
      (value.publicationCommands[2] = "fastlane ios unsafe_distribute"),
    (value) => (value.publicationCommands[3] = "fastlane ios unsafe_submit"),
    (value) => value.semanticPublicationGraphs.root["ios-review-submit"].pop(),
    (value) =>
      value.semanticPublicationGraphs.standalone["github-release"].push(
        "unsafe-stage",
      ),
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(
      await fingerprintReleasePackaging({ ...options, contract: changed }),
      first,
    );
  }
});

test("desktop runner pairing and publication graphs are release-significant", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS.desktop);
  const options = {
    contractName: "desktop",
    contract: base,
    metadata: {
      builderArguments: "--linux AppImage deb --x64",
      electronBuilderVersion: "26.0.0",
      electronVersion: "39.0.0",
      nodeVersion: "v26.0.0",
    },
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging(options);
  for (const mutate of [
    (value) => {
      [value.rootLegs[0].runner, value.rootLegs[1].runner] = [
        value.rootLegs[1].runner,
        value.rootLegs[0].runner,
      ];
    },
    (value) => value.semanticPublicationGraphs.root["github-publish"].pop(),
    (value) =>
      value.semanticPublicationGraphs.standalone["artifact-fan-in"].pop(),
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(
      await fingerprintReleasePackaging({ ...options, contract: changed }),
      first,
    );
  }
});

test("human action-version labels do not trigger package releases", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const contractName of ["native-cli", "desktop", "mobile", "openclaw"]) {
    const base = structuredClone(RELEASE_PACKAGING_CONTRACTS[contractName]);
    const changed = structuredClone(base);
    const actionName = Object.keys(changed.actionVersions)[0];
    changed.actionVersions[actionName] = "corrected-human-label";
    const options = {
      contractName,
      metadata: {
        builderArguments: "--linux AppImage deb --x64",
        electronBuilderVersion: "26.0.0",
        electronVersion: "39.0.0",
        nodeVersion: "v26.0.0",
      },
      root,
      paths: ["dist/index.cjs"],
    };
    assert.equal(
      await fingerprintReleasePackaging({ ...options, contract: changed }),
      await fingerprintReleasePackaging({ ...options, contract: base }),
      `${contractName} display labels must remain non-semantic`,
    );
  }
});

test("workflow job and artifact-routing renames remain non-semantic", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, paths: ["dist/index.cjs"] };

  const desktop = structuredClone(RELEASE_PACKAGING_CONTRACTS.desktop);
  const renamedDesktop = structuredClone(desktop);
  renamedDesktop.standaloneArtifactFanInPattern = "transport-renamed-*";
  renamedDesktop.standaloneReleaseFiles = "renamed-staging/*";
  for (const [index, target] of renamedDesktop.standaloneTargets.entries()) {
    target.job = `Renamed-${index}`;
    target.artifactName = target.artifactName
      ? `renamed-artifact-${index}`
      : null;
    target.artifactGlobs = target.artifactGlobs.map(
      (glob) => `renamed/${index}/${path.basename(glob)}`,
    );
  }
  const metadata = {
    builderArguments: "--linux AppImage deb --x64",
    electronBuilderVersion: "26.0.0",
    electronVersion: "39.0.0",
    nodeVersion: "v26.0.0",
  };
  assert.equal(
    await fingerprintReleasePackaging({
      ...options,
      contractName: "desktop",
      contract: renamedDesktop,
      metadata,
    }),
    await fingerprintReleasePackaging({
      ...options,
      contractName: "desktop",
      contract: desktop,
      metadata,
    }),
  );

  const mobile = structuredClone(RELEASE_PACKAGING_CONTRACTS.mobile);
  const renamedMobile = structuredClone(mobile);
  renamedMobile.publicationTopology = {
    buildJobs: ["renamed-android", "renamed-ios"],
    crossStoreTransaction: false,
    githubReleaseAfter: ["renamed-play", "renamed-submit"],
    iosPublicationSequence: [
      "renamed-upload",
      "renamed-distribute",
      "renamed-submit",
    ],
    publishJobs: [
      "renamed-play",
      "renamed-upload",
      "renamed-distribute",
      "renamed-submit",
    ],
    validatedArtifact: "renamed-handoff",
    validationFanInJob: "renamed-validation",
  };
  assert.equal(
    await fingerprintReleasePackaging({
      ...options,
      contractName: "mobile",
      contract: renamedMobile,
    }),
    await fingerprintReleasePackaging({
      ...options,
      contractName: "mobile",
      contract: mobile,
    }),
  );
});

test("OpenClaw attestation action and provenance format are fingerprinted", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = structuredClone(RELEASE_PACKAGING_CONTRACTS.openclaw);
  const options = {
    contractName: "openclaw",
    contract: base,
    root,
    paths: ["dist/index.cjs"],
  };
  const first = await fingerprintReleasePackaging(options);
  for (const mutate of [
    (value) => (value.actions.attestBuildProvenance = "mutable-tag"),
    (value) => (value.provenance.bundleFilename = "provenance.json"),
    (value) => (value.provenance.checksumAlgorithm = "sha512"),
    (value) => (value.provenance.format = "opaque-json"),
    (value) => (value.provenance.predicate = "custom-provenance"),
    (value) =>
      (value.provenance.verification.repository = "unbound-repository"),
    (value) =>
      (value.provenance.verification.signerWorkflow =
        ".github/workflows/untrusted.yml"),
    (value) => (value.provenance.verification.sourceDigest = "unbound-source"),
    (value) => value.provenance.subjects.pop(),
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(
      await fingerprintReleasePackaging({ ...options, contract: changed }),
      first,
    );
  }
});

test("desktop lock, patch, and builder configuration inputs are fingerprinted", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = [
    "app/yarn.lock",
    "app/.yarn/patches/native.patch",
    "desktop/package.json",
  ];
  for (const input of inputs) {
    mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
    writeFileSync(path.join(root, input), `original ${input}\n`);
  }
  const options = {
    contractName: "desktop",
    metadata: {
      builderArguments: "--linux AppImage deb --x64",
      electronBuilderVersion: "26.0.0",
      electronVersion: "39.0.0",
      nodeVersion: "v26.0.0",
    },
    root,
    paths: ["dist/index.cjs", ...inputs],
  };
  const first = await fingerprintReleasePackaging(options);
  for (const input of inputs) {
    const file = path.join(root, input);
    writeFileSync(file, `changed ${input}\n`);
    assert.notEqual(await fingerprintReleasePackaging(options), first);
    writeFileSync(file, `original ${input}\n`);
  }
});

test("native packaging rejects traversal and shell metacharacters before execution", () => {
  for (const tool of [
    "../srn-client",
    "srn-client;whoami",
    "srn-client$(whoami)",
  ]) {
    assert.throws(
      () => packageNativeCli({ tool, bundle: "dist/index.cjs", outDir: "out" }),
      /safe srn-\* basename/,
    );
  }
  assert.throws(
    () =>
      packageNativeCli({
        tool: "srn-client",
        bundle: "../outside.cjs",
        outDir: "out",
      }),
    /bundle must stay inside the working directory/,
  );
});

test("native packaging rejects unknown and command-inapplicable arguments", () => {
  assert.throws(
    () =>
      parseNativeCliArguments([
        "fingerprint",
        "--tool",
        "srn-client",
        "--unexpected",
        "ignored",
      ]),
    /does not apply to native fingerprint/,
  );
  assert.throws(
    () =>
      parseNativeCliArguments([
        "package",
        "--tool",
        "srn-client",
        "--path",
        "dist\/index.cjs",
      ]),
    /does not apply to native package/,
  );
});

test("native fingerprint and executor share the exact canonical invocation plan", () => {
  const root = fixture();
  const calls = [];
  try {
    const plan = packageNativeCli({
      tool: "srn-client",
      bundle: "dist/index.cjs",
      outDir: "out",
      platform: "linux",
      workingDirectory: root,
      spawn(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0 };
      },
    });
    assert.deepEqual(
      plan,
      nativeCliPackagePlan({
        tool: "srn-client",
        bundle: "dist/index.cjs",
        outDir: "out",
        platform: "linux",
        workingDirectory: root,
      }),
    );
    assert.equal(calls.length, 6);
    for (const [index, target] of RELEASE_PACKAGING_CONTRACTS[
      "native-cli"
    ].targets.entries()) {
      const invocation = plan.invocations[index];
      const output = `out/srn-client-${target.output}`;
      assert.deepEqual(invocation, {
        args: [
          "--yes",
          "@yao-pkg/pkg@6.21.0",
          "--no-signature",
          "--targets",
          `node24-${target.target}`,
          "--output",
          output,
          "dist/index.cjs",
        ],
        cwd: ".",
        executable: "npx",
        output,
        target: `node24-${target.target}`,
        type: "native-executable",
      });
      assert.deepEqual(calls[index].args, invocation.args);
      assert.equal(calls[index].executable, invocation.executable);
      assert.equal(calls[index].options.cwd, root);
      assert.equal(calls[index].options.shell, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("home-server supplemental packaging is part of the canonical plan", () => {
  const plan = nativeCliPackagePlan({
    tool: "srn-home-server",
    bundle: "bundle/home-server.cjs",
    outDir: "out",
    platform: "linux",
  });
  assert.deepEqual(plan.invocations.at(-1), {
    args: ["-qr", "../out/srn-home-server-migrations.zip", "migrations"],
    cwd: "bundle",
    executable: "zip",
    output: "out/srn-home-server-migrations.zip",
    target: "zip",
    type: "supplemental-artifact",
  });
});

test("native packaging propagates spawn errors and nonzero exits", () => {
  const root = fixture();
  const options = {
    tool: "srn-client",
    bundle: "dist/index.cjs",
    outDir: "out",
    platform: "linux",
    workingDirectory: root,
  };
  try {
    assert.throws(
      () =>
        packageNativeCli({
          ...options,
          spawn: () => ({ error: new Error("spawn failed"), status: null }),
        }),
      /spawn failed/,
    );
    assert.throws(
      () =>
        packageNativeCli({
          ...options,
          spawn: () => ({ status: 23 }),
        }),
      /native-executable command failed for node24-win-x64/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
