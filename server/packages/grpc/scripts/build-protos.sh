#!/bin/bash

set -euo pipefail

PROTO_DEST=./lib
PROTO_FILES=("$@")
if [[ ${#PROTO_FILES[@]} -eq 0 ]]; then
  PROTO_FILES=(proto/*.proto)
fi

mkdir -p "${PROTO_DEST}"

# grpc-tools resolves its bundled platform plugin itself. Avoid pinning Yarn's
# content-addressed unplugged path, which changes on dependency upgrades.
yarn run grpc_tools_node_protoc \
    --js_out=import_style=commonjs,binary:"${PROTO_DEST}" \
    --grpc_out=grpc_js:"${PROTO_DEST}" \
    -I ./proto \
    "${PROTO_FILES[@]}"

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  TS_PLUGIN="$(cygpath -w ./scripts/protoc-gen-ts.cmd)"
else
  TS_PLUGIN="$(yarn bin protoc-gen-ts)"
fi

yarn run grpc_tools_node_protoc \
    --plugin=protoc-gen-ts="${TS_PLUGIN}" \
    --ts_out=grpc_js:"${PROTO_DEST}" \
    -I ./proto \
    "${PROTO_FILES[@]}"

GENERATED_DECLARATIONS=()
for proto_file in "${PROTO_FILES[@]}"; do
  proto_name="$(basename "${proto_file}" .proto)"
  GENERATED_DECLARATIONS+=(
    "${PROTO_DEST}/${proto_name}_pb.d.ts"
    "${PROTO_DEST}/${proto_name}_grpc_pb.d.ts"
  )
done

# grpc_tools_node_protoc_ts emits trailing spaces on class declarations. Strip
# them deterministically so regeneration stays compatible with diff checks.
node - "${GENERATED_DECLARATIONS[@]}" <<'NODE'
const fs = require('node:fs')

for (const path of process.argv.slice(2)) {
  if (!fs.existsSync(path)) {
    continue
  }
  const source = fs.readFileSync(path, 'utf8')
  const normalized = source.replace(/[ \t]+$/gmu, '')
  if (normalized !== source) {
    fs.writeFileSync(path, normalized)
  }
}
NODE
