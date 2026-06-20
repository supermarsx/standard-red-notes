/**
 * Minimal ambient declaration for sql.js (the WASM SQLite build). The package
 * ships no TypeScript types and is only ever lazily `import()`-ed in
 * SqlQueryNode, where the result is narrowed to the small surface we use, so we
 * keep this intentionally loose (mirrors the qrcode.react ambient module).
 */
declare module 'sql.js'
