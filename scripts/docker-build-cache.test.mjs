import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const instructions = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
const runtime = (path) =>
  instructions(read(path)).slice(instructions(read(path)).lastIndexOf("FROM "));

for (const path of ["app/Dockerfile", "server/Dockerfile"]) {
  test(`${path}: revision-only changes do not invalidate runtime setup or artifact ownership`, () => {
    const source = runtime(path);
    const identity = source.indexOf("ARG SRN_DEPLOY_REVISION");
    assert.ok(identity > 0);
    assert.ok(
      source.lastIndexOf("\nRUN ") < identity,
      "runtime setup must precede revision scope",
    );
    assert.ok(
      source.lastIndexOf("COPY --from=build") < identity,
      "built artifacts must precede revision scope",
    );
    assert.ok(source.indexOf("COPY --from=deployment-identity") > identity);
    assert.match(
      source,
      /COPY --from=deployment-identity --chown=0:0 --chmod=0444/,
    );
  });
}

test("web dependencies build before revision scope; the stamped bundle still builds cold with its portable-output check", () => {
  const source = instructions(read("app/Dockerfile"));
  const buildStage = source.slice(
    source.indexOf("FROM node:"),
    source.lastIndexOf("FROM "),
  );
  const dependencies = buildStage.indexOf(
    "RUN yarn workspaces foreach -pt --topological-dev --verbose -R --from @standardnotes/web --exclude @standardnotes/web run build",
  );
  const revision = buildStage.indexOf("ARG SRN_DEPLOY_REVISION");
  const web = buildStage.indexOf(
    'RUN SRN_DEPLOY_REVISION="${SRN_DEPLOY_REVISION}" yarn workspace @standardnotes/web build',
  );
  assert.ok(dependencies > 0 && dependencies < revision && revision < web);
  assert.doesNotMatch(buildStage.slice(dependencies), /--mount=type=cache/);
  assert.match(
    JSON.parse(read("app/packages/web/package.json")).scripts.build,
    /AssertPortableBundle\.mjs/,
  );
});

test("UI-only source changes cannot invalidate the compiled library layer", () => {
  const source = instructions(read("app/Dockerfile"));
  const stage = source.slice(
    source.indexOf("FROM node:"),
    source.lastIndexOf("FROM "),
  );
  const build = stage.indexOf("RUN yarn workspaces foreach");
  const libraryInputs = stage.slice(0, build);
  assert.ok(build > 0);
  assert.doesNotMatch(libraryInputs, /^COPY\s+\.\s+\./m);
  assert.doesNotMatch(libraryInputs, /^COPY\s+packages\/\s/m);
  assert.doesNotMatch(
    libraryInputs,
    /^COPY\s+packages\/web\/(?!package\.json\s)/m,
  );
  assert.ok(
    stage.indexOf("COPY . .") > build,
    "the full source overlay belongs after the library build",
  );
  assert.ok(
    stage.indexOf("COPY . .") < stage.indexOf("ARG SRN_DEPLOY_REVISION"),
  );
  assert.match(
    libraryInputs,
    /^COPY tsconfig\.base\.json UILib\.tsconfig\.json \.\//m,
  );
  assert.match(libraryInputs, /^COPY scripts\/ scripts\//m);
  // The overlay must never replace freshly built outputs with local artifacts.
  assert.match(read("app/.dockerignore"), /^packages\/\*\/dist$/m);
  assert.match(read("app/.dockerignore"), /^\*\*\/node_modules$/m);
});

test("every transitive web workspace has its complete source copied before the library build", () => {
  const packagesRoot = fileURLToPath(
    new URL("../app/packages/", import.meta.url),
  );
  const workspaces = new Map(
    readdirSync(packagesRoot)
      .filter((directory) =>
        existsSync(`${packagesRoot}/${directory}/package.json`),
      )
      .map((directory) => {
        const manifest = JSON.parse(
          read(`app/packages/${directory}/package.json`),
        );
        return [manifest.name, { directory, manifest }];
      }),
  );
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const { manifest } = workspaces.get(name);
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (workspaces.has(dependency)) visit(dependency);
    }
  };
  visit("@standardnotes/web");
  const source = instructions(read("app/Dockerfile"));
  const libraryInputs = source.slice(
    source.indexOf("FROM node:"),
    source.indexOf("RUN yarn workspaces foreach"),
  );
  const copied = new Set(
    [
      ...libraryInputs.matchAll(/^COPY packages\/(\S+)\/ packages\/\1\/$/gm),
    ].map((match) => match[1]),
  );
  const required = [...visited]
    .filter((name) => name !== "@standardnotes/web")
    .map((name) => workspaces.get(name).directory);
  assert.deepEqual(
    [...copied].sort(),
    required.sort(),
    "keep Docker library sources in sync with the workspace graph",
  );
});

test("web artifacts are copied with their writable runtime owner instead of a recursive chown layer", () => {
  const source = runtime("app/Dockerfile");
  assert.match(
    source,
    /COPY --from=build --chown=nginx:nginx .*\/dist \/usr\/share\/nginx\/html/,
  );
  assert.match(source, /COPY --chown=nginx:nginx docker\/nginx\.conf/);
  assert.match(source, /COPY --chmod=0555 docker\/docker-entrypoint\.sh/);
  assert.doesNotMatch(source, /chown -R nginx/);
  assert.match(source, /RUN chown nginx:nginx \/usr\/share\/nginx\/html/);
  assert.match(source, /USER nginx/);
});

test("server artifact ownership is assigned during copy without rewriting dependencies", () => {
  const source = runtime("server/Dockerfile");
  const copy = source.indexOf(
    "COPY --from=build --chown=10001:10001 /opt/server /opt/server",
  );
  assert.ok(copy > 0);
  assert.ok(source.indexOf("addgroup -g 10001") < copy);
  assert.doesNotMatch(source.slice(copy), /chown -R[^\n]*\/opt\/server/);
  assert.match(
    source,
    /chown srn:srn \/opt\/server \/opt\/server\/packages\/api-gateway\/data/,
  );
});
