export * from './Bootstrap'
// Standard Red Notes: the one composition of the `/healthcheck/diagnostics`
// answer. Exported because the bundled home-server serves that route from a
// loopback-only internal listener of its own — auth has no HTTP port on that
// topology — and a second copy of the composition is how one entry point gets
// fixed and its twin does not. Decorator-free, so importing it registers no
// route: auth's annotated controllers are deliberately absent from this barrel
// (they declare unprefixed bases such as `/auth`, `/sessions` and `/internal`).
export * from './Infra/Diagnostics/AuthRuntimeDiagnosticsEndpoint'
