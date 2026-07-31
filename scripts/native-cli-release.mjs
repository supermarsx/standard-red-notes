#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RELEASE_PACKAGING_CONTRACTS,
  fingerprintReleasePackaging,
} from "./release-packaging-contract.mjs";

const contract = RELEASE_PACKAGING_CONTRACTS["native-cli"];
// srn-native-executor-v4 supersedes the exact-byte srn-native-executor-v3.
const NATIVE_EXECUTOR_IMPLEMENTATION_SCHEMA = "srn-native-executor-v4";
const NATIVE_EXECUTOR_RAW_FALLBACK_NORMALIZER = Object.freeze({
  encoding: "utf8",
  name: "srn-js-source-bytes",
  version: "1",
});
const NATIVE_EXECUTOR_SEMANTIC_NORMALIZER = Object.freeze({
  encoding: "canonical-json",
  name: "srn-babel-semantic-ast",
  version: "1",
});
const NATIVE_EXECUTOR_IMPLEMENTATION_FILE = fileURLToPath(import.meta.url);
const NATIVE_SEMANTIC_PARSER = Object.freeze({
  name: "@babel/parser",
  version: "7.29.7",
});
const nativeRequire = createRequire(import.meta.url);

export const NATIVE_CLI_RELEASE_PRODUCTS = Object.freeze([
  "srn-admin",
  "srn-client",
  "srn-home-server",
  "srn-mcp",
  "srn-server",
]);
export const RELEASE_PACKAGING_CONTRACT_PRODUCTS = Object.freeze([
  ...NATIVE_CLI_RELEASE_PRODUCTS,
  "srn-desktop",
  "srn-mobile",
  "srn-openclaw",
]);

// These records are part of the executable contract. Product-local behavior
// must update only its own record; shared behavior lives in the remaining AST.
// The analyzer verifies that every record is present and rejects unknown ones.
export const NATIVE_CLI_PRODUCT_SEMANTICS = Object.freeze({
  "srn-admin": Object.freeze({ planSchema: 1 }),
  "srn-client": Object.freeze({ planSchema: 1 }),
  "srn-home-server": Object.freeze({
    planSchema: 1,
    supplementalArtifactPlanSchema: 1,
  }),
  "srn-mcp": Object.freeze({ planSchema: 1 }),
  "srn-server": Object.freeze({ planSchema: 1 }),
});

export const NATIVE_CLI_PRODUCT_AST_BINDINGS = Object.freeze({
  "srn-home-server": Object.freeze(["appendHomeServerSupplementalInvocations"]),
});
const NATIVE_AST_TRIVIA_KEYS = new Set([
  "comments",
  "end",
  "errors",
  "extra",
  "innerComments",
  "leadingComments",
  "loc",
  "raw",
  "start",
  "tokens",
  "trailingComments",
]);

let cachedNativeParser;

function nativeJavaScriptParser() {
  if (cachedNativeParser !== undefined) {
    return cachedNativeParser;
  }
  try {
    const parserModule = nativeRequire(NATIVE_SEMANTIC_PARSER.name);
    const parserManifest = nativeRequire(
      `${NATIVE_SEMANTIC_PARSER.name}/package.json`,
    );
    if (
      typeof parserModule.parse !== "function" ||
      parserManifest.version !== NATIVE_SEMANTIC_PARSER.version
    ) {
      throw new Error(
        `expected ${NATIVE_SEMANTIC_PARSER.name}@${NATIVE_SEMANTIC_PARSER.version}`,
      );
    }
    cachedNativeParser = Object.freeze({
      parse: parserModule.parse,
      version: parserManifest.version,
    });
  } catch (error) {
    cachedNativeParser = Object.freeze({
      error: error instanceof Error ? error.message : String(error),
      parse: null,
      version: null,
    });
  }
  return cachedNativeParser;
}

function parseNativeExecutorAst(source) {
  const parser = nativeJavaScriptParser();
  if (!parser?.parse) {
    throw new Error(
      `the native semantic JavaScript parser is unavailable: ${parser?.error ?? "unknown loader error"}`,
    );
  }
  const ast = parser.parse(source, {
    allowReturnOutsideFunction: false,
    attachComment: false,
    sourceType: "module",
  });
  return {
    parserVersion: parser.version,
    program: ast.program,
  };
}

function canonicalNativeAst(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalNativeAst);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !NATIVE_AST_TRIVIA_KEYS.has(key))
      .sort()
      .map((key) => [key, canonicalNativeAst(value[key])]),
  );
}

function statementDeclaration(statement) {
  return statement.type === "ExportNamedDeclaration"
    ? statement.declaration
    : statement;
}

function declaredStatementName(statement) {
  const declaration = statementDeclaration(statement);
  if (declaration?.type === "FunctionDeclaration") {
    return declaration.id?.name;
  }
  if (
    declaration?.type === "VariableDeclaration" &&
    declaration.declarations.length === 1
  ) {
    return declaration.declarations[0].id?.name;
  }
  return undefined;
}

function unwrapFrozenExpression(expression) {
  if (
    expression?.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    expression.callee?.type !== "MemberExpression" ||
    expression.callee.computed !== false ||
    expression.callee.object?.type !== "Identifier" ||
    expression.callee.object.name !== "Object" ||
    expression.callee.property?.type !== "Identifier" ||
    expression.callee.property.name !== "freeze"
  ) {
    throw new Error("native semantic objects must use Object.freeze");
  }
  return expression.arguments[0];
}

function unwrapFrozenObject(expression) {
  expression = unwrapFrozenExpression(expression);
  if (expression?.type !== "ObjectExpression") {
    throw new Error("native product semantics must be an object literal");
  }
  return expression;
}

function variableDeclarationInitializer(statement, name) {
  const declaration = statementDeclaration(statement);
  if (
    declaration?.type !== "VariableDeclaration" ||
    declaration.declarations.length !== 1 ||
    declaration.declarations[0].id?.name !== name
  ) {
    throw new Error(`semantic declaration '${name}' is malformed`);
  }
  return declaration.declarations[0].init;
}

function objectPropertyName(property) {
  if (
    !new Set(["ObjectProperty", "Property"]).has(property.type) ||
    property.computed ||
    (property.type === "Property" && property.kind !== "init")
  ) {
    throw new Error(
      "native product semantics require static object properties",
    );
  }
  if (new Set(["Literal", "StringLiteral"]).has(property.key.type)) {
    return property.key.value;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  throw new Error("native product semantics contain an unsupported key");
}

function nativeExecutorSemanticPartitions(source) {
  const ast = parseNativeExecutorAst(source);
  const sharedBody = [];
  const productNodes = new Map(
    NATIVE_CLI_RELEASE_PRODUCTS.map((product) => [product, []]),
  );
  const productFunctions = new Map();
  const bindingStatements = ast.program.body.filter(
    (statement) =>
      declaredStatementName(statement) === "NATIVE_CLI_PRODUCT_AST_BINDINGS",
  );
  if (bindingStatements.length !== 1) {
    throw new Error("native product AST bindings require one declaration");
  }
  const bindings = unwrapFrozenObject(
    variableDeclarationInitializer(
      bindingStatements[0],
      "NATIVE_CLI_PRODUCT_AST_BINDINGS",
    ),
  );
  const bindingProducts = new Set();
  for (const property of bindings.properties) {
    const product = objectPropertyName(property);
    if (!productNodes.has(product) || bindingProducts.has(product)) {
      throw new Error(
        `unknown or duplicate native AST binding product '${product}'`,
      );
    }
    bindingProducts.add(product);
    const names = unwrapFrozenExpression(property.value);
    if (names.type !== "ArrayExpression") {
      throw new Error(`native AST bindings for '${product}' must be an array`);
    }
    for (const element of names.elements) {
      if (
        !new Set(["Literal", "StringLiteral"]).has(element?.type) ||
        typeof element.value !== "string" ||
        element.value.length === 0
      ) {
        throw new Error(`native AST bindings for '${product}' are invalid`);
      }
      const name = element.value;
      if (productFunctions.has(name)) {
        throw new Error(`native semantic function '${name}' has two owners`);
      }
      productFunctions.set(name, product);
    }
  }

  let foundProductSemantics = false;
  let foundProductBindings = false;
  let foundProductPlanAppenders = false;
  const foundProductFunctions = new Set();
  for (const statement of ast.program.body) {
    const name = declaredStatementName(statement);
    if (name === "NATIVE_CLI_PRODUCT_SEMANTICS") {
      if (foundProductSemantics) {
        throw new Error("native product semantics are declared more than once");
      }
      const semanticsObject = unwrapFrozenObject(
        variableDeclarationInitializer(
          statement,
          "NATIVE_CLI_PRODUCT_SEMANTICS",
        ),
      );
      const foundProducts = new Set();
      for (const property of semanticsObject.properties) {
        const product = objectPropertyName(property);
        if (!productNodes.has(product) || foundProducts.has(product)) {
          throw new Error(`unknown or duplicate native product '${product}'`);
        }
        foundProducts.add(product);
        productNodes.get(product).push(property);
      }
      if (foundProducts.size !== NATIVE_CLI_RELEASE_PRODUCTS.length) {
        throw new Error("native product semantics are incomplete");
      }
      foundProductSemantics = true;
      continue;
    }
    if (name === "NATIVE_CLI_PRODUCT_AST_BINDINGS") {
      if (foundProductBindings) {
        throw new Error("native product AST bindings are declared twice");
      }
      for (const property of bindings.properties) {
        productNodes.get(objectPropertyName(property)).push(property);
      }
      foundProductBindings = true;
      continue;
    }
    if (name === "NATIVE_CLI_PRODUCT_PLAN_APPENDERS") {
      if (foundProductPlanAppenders) {
        throw new Error("native product plan appenders are declared twice");
      }
      const appenders = unwrapFrozenObject(
        variableDeclarationInitializer(
          statement,
          "NATIVE_CLI_PRODUCT_PLAN_APPENDERS",
        ),
      );
      const foundProducts = new Set();
      for (const property of appenders.properties) {
        const product = objectPropertyName(property);
        if (
          !bindingProducts.has(product) ||
          foundProducts.has(product) ||
          property.value.type !== "Identifier" ||
          productFunctions.get(property.value.name) !== product
        ) {
          throw new Error(
            `native product plan appender for '${product}' is ambiguous`,
          );
        }
        foundProducts.add(product);
        productNodes.get(product).push(property);
      }
      if (foundProducts.size !== bindingProducts.size) {
        throw new Error("native product plan appenders are incomplete");
      }
      foundProductPlanAppenders = true;
      continue;
    }
    const product = productFunctions.get(name);
    if (product) {
      foundProductFunctions.add(name);
      productNodes.get(product).push(statement);
      continue;
    }
    sharedBody.push(statement);
  }

  if (
    !foundProductSemantics ||
    !foundProductBindings ||
    !foundProductPlanAppenders
  ) {
    throw new Error("native product semantic declarations are incomplete");
  }
  for (const name of productFunctions.keys()) {
    if (!foundProductFunctions.has(name)) {
      throw new Error(`native product function '${name}' is missing`);
    }
  }

  const { body: _body, ...programMetadata } = ast.program;
  return {
    products: Object.fromEntries(
      NATIVE_CLI_RELEASE_PRODUCTS.map((product) => [
        product,
        canonicalNativeAst(productNodes.get(product)),
      ]),
    ),
    shared: canonicalNativeAst({
      ...programMetadata,
      body: sharedBody,
      parserVersion: ast.parserVersion,
    }),
  };
}

function releasePackagingContractSemanticPartitions(source) {
  const ast = parseNativeExecutorAst(source);
  const sharedBody = [];
  const productNodes = new Map(
    RELEASE_PACKAGING_CONTRACT_PRODUCTS.map((product) => [product, []]),
  );
  let nativeShared;
  let foundContract = false;

  for (const statement of ast.program.body) {
    if (declaredStatementName(statement) !== "RELEASE_PACKAGING_CONTRACTS") {
      sharedBody.push(statement);
      continue;
    }
    if (foundContract) {
      throw new Error(
        "release packaging contracts are declared more than once",
      );
    }
    const contracts = unwrapFrozenObject(
      variableDeclarationInitializer(statement, "RELEASE_PACKAGING_CONTRACTS"),
    );
    const foundSections = new Set();
    for (const section of contracts.properties) {
      const sectionName = objectPropertyName(section);
      if (foundSections.has(sectionName)) {
        throw new Error(`duplicate release packaging section '${sectionName}'`);
      }
      foundSections.add(sectionName);
      if (sectionName === "native-cli") {
        const nativeContract = unwrapFrozenObject(section.value);
        const sharedProperties = [];
        let foundNativeProducts = false;
        for (const property of nativeContract.properties) {
          if (objectPropertyName(property) !== "products") {
            sharedProperties.push(property);
            continue;
          }
          if (foundNativeProducts) {
            throw new Error(
              "native product packaging contracts are duplicated",
            );
          }
          foundNativeProducts = true;
          const products = unwrapFrozenObject(property.value);
          const foundProducts = new Set();
          for (const productProperty of products.properties) {
            const product = objectPropertyName(productProperty);
            if (
              !NATIVE_CLI_RELEASE_PRODUCTS.includes(product) ||
              foundProducts.has(product)
            ) {
              throw new Error(
                `unknown or duplicate native packaging product '${product}'`,
              );
            }
            foundProducts.add(product);
            productNodes.get(product).push(productProperty);
          }
        }
        if (!foundNativeProducts) {
          throw new Error("native product packaging contracts are missing");
        }
        nativeShared = canonicalNativeAst({
          key: section.key,
          properties: sharedProperties,
        });
        continue;
      }
      const product =
        sectionName === "desktop"
          ? "srn-desktop"
          : sectionName === "mobile"
            ? "srn-mobile"
            : sectionName === "openclaw"
              ? "srn-openclaw"
              : undefined;
      if (!product) {
        throw new Error(`unknown release packaging section '${sectionName}'`);
      }
      unwrapFrozenObject(section.value);
      productNodes.get(product).push(section);
    }
    for (const requiredSection of [
      "native-cli",
      "desktop",
      "mobile",
      "openclaw",
    ]) {
      if (!foundSections.has(requiredSection)) {
        throw new Error(
          `release packaging section '${requiredSection}' is missing`,
        );
      }
    }
    foundContract = true;
  }
  if (!foundContract || !nativeShared) {
    throw new Error("release packaging contracts are missing");
  }

  const { body: _body, ...programMetadata } = ast.program;
  return {
    nativeShared,
    products: Object.fromEntries(
      RELEASE_PACKAGING_CONTRACT_PRODUCTS.map((product) => [
        product,
        canonicalNativeAst(productNodes.get(product)),
      ]),
    ),
    shared: canonicalNativeAst({
      ...programMetadata,
      body: sharedBody,
      parserVersion: ast.parserVersion,
    }),
  };
}

export function classifyReleasePackagingContractSemanticChange({
  beforeSource,
  afterSource,
}) {
  if (beforeSource === afterSource) {
    return {
      affectedProducts: [],
      classification: "unchanged",
      nativeSharedChanged: false,
      productChanges: [],
      sharedChanged: false,
    };
  }
  let after;
  try {
    after = releasePackagingContractSemanticPartitions(afterSource);
  } catch (error) {
    return {
      affectedProducts: [...RELEASE_PACKAGING_CONTRACT_PRODUCTS],
      classification: "ambiguous",
      error: error instanceof Error ? error.message : String(error),
      nativeSharedChanged: true,
      productChanges: [],
      sharedChanged: true,
    };
  }
  let before;
  try {
    before = releasePackagingContractSemanticPartitions(beforeSource);
  } catch (error) {
    return {
      affectedProducts: [...RELEASE_PACKAGING_CONTRACT_PRODUCTS],
      classification: "shared",
      migration: true,
      migrationReason: error instanceof Error ? error.message : String(error),
      nativeSharedChanged: true,
      productChanges: [],
      sharedChanged: true,
    };
  }
  try {
    const sharedChanged =
      JSON.stringify(before.shared) !== JSON.stringify(after.shared);
    const nativeSharedChanged =
      JSON.stringify(before.nativeShared) !==
      JSON.stringify(after.nativeShared);
    const productChanges = RELEASE_PACKAGING_CONTRACT_PRODUCTS.filter(
      (product) =>
        JSON.stringify(before.products[product]) !==
        JSON.stringify(after.products[product]),
    );
    const affectedProducts = sharedChanged
      ? [...RELEASE_PACKAGING_CONTRACT_PRODUCTS]
      : [
          ...(nativeSharedChanged ? NATIVE_CLI_RELEASE_PRODUCTS : []),
          ...productChanges,
        ].filter(
          (product, index, products) => products.indexOf(product) === index,
        );
    return {
      affectedProducts,
      classification:
        affectedProducts.length === 0
          ? "unchanged"
          : sharedChanged
            ? "shared"
            : productChanges.length === 1 && !nativeSharedChanged
              ? "product"
              : "scoped",
      nativeSharedChanged,
      productChanges,
      sharedChanged,
    };
  } catch (error) {
    return {
      affectedProducts: [...RELEASE_PACKAGING_CONTRACT_PRODUCTS],
      classification: "ambiguous",
      error: error instanceof Error ? error.message : String(error),
      nativeSharedChanged: true,
      productChanges: [],
      sharedChanged: true,
    };
  }
}

function nativeExecutorSemanticPayload(source, tool) {
  const partitions = nativeExecutorSemanticPartitions(source);
  if (tool !== undefined && !NATIVE_CLI_RELEASE_PRODUCTS.includes(tool)) {
    throw new TypeError(`unknown native release product: ${tool}`);
  }
  return {
    products:
      tool === undefined
        ? partitions.products
        : { [tool]: partitions.products[tool] },
    schema: NATIVE_EXECUTOR_IMPLEMENTATION_SCHEMA,
    shared: partitions.shared,
  };
}

export function nativeCliExecutorImplementationSource() {
  return readFileSync(NATIVE_EXECUTOR_IMPLEMENTATION_FILE, "utf8");
}

export function normalizeNativeExecutorSource(source, tool) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("native executor implementation source is required");
  }
  try {
    return JSON.stringify(nativeExecutorSemanticPayload(source, tool));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "the native semantic JavaScript parser is unavailable",
      )
    ) {
      throw new Error(
        `Native executor semantic identity requires ${NATIVE_SEMANTIC_PARSER.name}@${NATIVE_SEMANTIC_PARSER.version}; run 'npm ci --prefix scripts --ignore-scripts --no-audit --no-fund' before fingerprinting. ${error.message}`,
      );
    }
    // Parsing or an unrecognized semantic structure is ambiguous. Hashing the
    // exact source fails closed by permitting an extra release, never a reuse.
    return source;
  }
}

export function nativeCliExecutorIdentity(
  source = nativeCliExecutorImplementationSource(),
  tool,
) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("native executor implementation source is required");
  }
  const normalized = normalizeNativeExecutorSource(source, tool);
  return {
    normalizer:
      normalized === source
        ? NATIVE_EXECUTOR_RAW_FALLBACK_NORMALIZER
        : NATIVE_EXECUTOR_SEMANTIC_NORMALIZER,
    schema: NATIVE_EXECUTOR_IMPLEMENTATION_SCHEMA,
    sha256: createHash("sha256").update(normalized).digest("hex"),
  };
}

export function classifyNativeCliExecutorSemanticChange({
  beforeSource,
  afterSource,
}) {
  if (beforeSource === afterSource) {
    return {
      affectedProducts: [],
      classification: "unchanged",
      productChanges: [],
      sharedChanged: false,
    };
  }
  let after;
  try {
    after = nativeExecutorSemanticPartitions(afterSource);
  } catch (error) {
    return {
      affectedProducts: [...NATIVE_CLI_RELEASE_PRODUCTS],
      classification: "ambiguous",
      error: error instanceof Error ? error.message : String(error),
      productChanges: [],
      sharedChanged: true,
    };
  }
  let before;
  try {
    before = nativeExecutorSemanticPartitions(beforeSource);
  } catch (error) {
    return {
      affectedProducts: [...NATIVE_CLI_RELEASE_PRODUCTS],
      classification: "shared",
      migration: true,
      migrationReason: error instanceof Error ? error.message : String(error),
      productChanges: [],
      sharedChanged: true,
    };
  }
  try {
    const sharedChanged =
      JSON.stringify(before.shared) !== JSON.stringify(after.shared);
    const productChanges = NATIVE_CLI_RELEASE_PRODUCTS.filter(
      (product) =>
        JSON.stringify(before.products[product]) !==
        JSON.stringify(after.products[product]),
    );
    const affectedProducts = sharedChanged
      ? [...NATIVE_CLI_RELEASE_PRODUCTS]
      : productChanges;
    return {
      affectedProducts,
      classification:
        affectedProducts.length === 0
          ? "unchanged"
          : sharedChanged
            ? "shared"
            : "product",
      productChanges,
      sharedChanged,
    };
  } catch (error) {
    return {
      affectedProducts: [...NATIVE_CLI_RELEASE_PRODUCTS],
      classification: "ambiguous",
      error: error instanceof Error ? error.message : String(error),
      productChanges: [],
      sharedChanged: true,
    };
  }
}

export function parseNativeCliArguments(argv) {
  const command = argv[0];
  if (!new Set(["fingerprint", "package"]).has(command)) {
    throw new TypeError("expected command 'fingerprint' or 'package'");
  }
  const allowed =
    command === "fingerprint"
      ? new Set([
          "--bundle",
          "--github-output",
          "--out-dir",
          "--output",
          "--path",
          "--root",
          "--tool",
        ])
      : new Set(["--bundle", "--out-dir", "--tool"]);
  const repeatedPaths = [];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new TypeError(
        `expected --name value arguments; received ${argv.join(" ")}`,
      );
    }
    if (!allowed.has(flag)) {
      throw new TypeError(
        `argument '${flag}' does not apply to native ${command}`,
      );
    }
    if (flag === "--path") {
      repeatedPaths.push(value);
    } else if (values.has(flag)) {
      throw new TypeError(`argument '${flag}' was supplied more than once`);
    } else {
      values.set(flag, value);
    }
  }
  return {
    bundle: values.get("--bundle"),
    command,
    githubOutput: values.get("--github-output"),
    output: values.get("--output"),
    outDir: values.get("--out-dir"),
    paths: repeatedPaths,
    root: values.get("--root"),
    tool: values.get("--tool"),
  };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function safeTool(value) {
  const tool = required(value, "tool");
  if (!/^srn-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool)) {
    throw new TypeError(`tool must be a safe srn-* basename: ${tool}`);
  }
  return tool;
}

function insideWorkingDirectory(value, name, workingDirectory) {
  const absolute = path.resolve(workingDirectory, required(value, name));
  const relation = path.relative(workingDirectory, absolute);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new TypeError(`${name} must stay inside the working directory`);
  }
  return relation.replaceAll(path.sep, "/") || ".";
}

function appendHomeServerSupplementalInvocations({
  bundle,
  invocations,
  outDir,
  packagingContract,
}) {
  const bundleDirectory = path.posix.dirname(bundle);
  const product = packagingContract.products?.["srn-home-server"];
  for (const artifact of product?.supplementalArtifacts ?? []) {
    const output = path.posix.join(outDir, artifact.output);
    invocations.push({
      args: [
        ...artifact.flags,
        path.posix.relative(bundleDirectory, output),
        artifact.input,
      ],
      cwd: bundleDirectory,
      executable: artifact.executable,
      output,
      target: artifact.format,
      type: "supplemental-artifact",
    });
  }
}

const NATIVE_CLI_PRODUCT_PLAN_APPENDERS = Object.freeze({
  "srn-home-server": appendHomeServerSupplementalInvocations,
});

export function nativeCliPackagePlan({
  tool,
  bundle,
  outDir,
  packagingContract = contract,
  platform = process.platform,
  workingDirectory = process.cwd(),
}) {
  tool = safeTool(tool);
  bundle = insideWorkingDirectory(bundle, "bundle", workingDirectory);
  outDir = insideWorkingDirectory(outDir, "out-dir", workingDirectory);
  const executable = platform === "win32" ? "npx.cmd" : "npx";
  const invocations = packagingContract.targets.map((target) => {
    const output = path.posix.join(outDir, `${tool}-${target.output}`);
    const pkgTarget = `${packagingContract.embeddedRuntime}-${target.target}`;
    return {
      args: [
        "--yes",
        `${packagingContract.packager.name}@${packagingContract.packager.version}`,
        ...packagingContract.packager.flags,
        "--targets",
        pkgTarget,
        "--output",
        output,
        bundle,
      ],
      cwd: ".",
      executable,
      output,
      target: pkgTarget,
      type: "native-executable",
    };
  });
  NATIVE_CLI_PRODUCT_PLAN_APPENDERS[tool]?.({
    bundle,
    invocations,
    outDir,
    packagingContract,
  });
  return { bundle, invocations, outDir, tool };
}

export async function fingerprintNativeCliRelease({
  tool,
  bundle,
  outDir,
  root,
  paths,
  packagingContract = contract,
  executorIdentity,
  platform = process.platform,
  workingDirectory = process.cwd(),
}) {
  tool = safeTool(tool);
  executorIdentity ??= nativeCliExecutorIdentity(undefined, tool);
  const { products = {}, ...sharedContract } = packagingContract;
  const productContract = products[tool] ?? { supplementalArtifacts: [] };
  const executionPlan = nativeCliPackagePlan({
    tool,
    bundle,
    outDir,
    packagingContract,
    platform,
    workingDirectory,
  });
  return fingerprintReleasePackaging({
    contractName: "native-cli",
    contract: {
      ...sharedContract,
      executorIdentity,
      executionPlan,
      product: productContract,
    },
    metadata: { tool },
    root: required(root, "root"),
    paths,
  });
}

export function packageNativeCli({
  tool,
  bundle,
  outDir,
  packagingContract = contract,
  platform = process.platform,
  spawn = spawnSync,
  workingDirectory = process.cwd(),
}) {
  const plan = nativeCliPackagePlan({
    tool,
    bundle,
    outDir,
    packagingContract,
    platform,
    workingDirectory,
  });
  mkdirSync(path.resolve(workingDirectory, plan.outDir), { recursive: true });
  for (const invocation of plan.invocations) {
    process.stdout.write(
      `${invocation.type} ${invocation.target} -> ${invocation.output}\n`,
    );
    const result = spawn(invocation.executable, invocation.args, {
      cwd: path.resolve(workingDirectory, invocation.cwd),
      encoding: "utf8",
      shell: false,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `${invocation.type} command failed for ${invocation.target}`,
      );
    }
  }
  return plan;
}

async function main() {
  const options = parseNativeCliArguments(process.argv.slice(2));
  if (options.command === "package") {
    packageNativeCli(options);
    return;
  }
  if (options.paths.length === 0) {
    throw new TypeError("at least one --path is required");
  }
  const fingerprint = await fingerprintNativeCliRelease(options);
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
      `Native CLI release failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
