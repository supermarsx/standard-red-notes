// Preload used by one test to make a REAL Node process-level notice appear on a
// child's stderr, so the harness's notice-splitting is proven end-to-end rather
// than only against a hand-written string.
//
// Node's default warning printer formats this as
//   (node:1234) HarnessTestWarning: synthetic notice from the test harness
// which is the same shape as the DEP0205 deprecation that turned CI red.
process.emitWarning('synthetic notice from the test harness', 'HarnessTestWarning')
