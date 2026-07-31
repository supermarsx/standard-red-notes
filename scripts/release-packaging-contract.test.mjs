import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fingerprintNativeCliRelease,
  nativeCliPackagePlan,
  packageNativeCli,
  parseNativeCliArguments,
} from "./native-cli-release.mjs";
import {
  RELEASE_PACKAGING_CONTRACTS,
  canonicalJson,
  fingerprintReleasePackaging,
} from "./release-packaging-contract.mjs";

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

test("native package fingerprints cover runtime, targets, flags, and action versions", async (t) => {
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
    (value) => (value.actions.setupNode = "v8"),
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
      mutate: (value) => (value.targets[2] = "--linux AppImage rpm --x64"),
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

test("mobile JDK, Ruby, Xcode, runner, action, and architecture contracts are material", async (t) => {
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
    (value) => (value.actions.setupJava = "v6"),
    (value) => value.androidArchitectures.push("armeabi-v7a"),
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
