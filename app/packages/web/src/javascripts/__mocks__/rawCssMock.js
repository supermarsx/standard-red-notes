// Test double for webpack inline-loader imports of raw stylesheet TEXT, e.g.
// `import css from '!css-loader?{…}!sass-loader?{…}!…/_colors.scss'`. Consumers
// (NoteExportUtils.superHTML) call `.toString()` on the value to inline it, so the
// double must be a real String. identity-obj-proxy — which every other `.scss`
// request maps to — returns the property name as a string for every key, so its
// `.toString` is the string "toString" and calling it throws.
// A CJS string export has no `__esModule`, so ts-jest's `__importDefault` wraps it
// and the imported default is ''.
module.exports = ''
