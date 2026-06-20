/**
 * Minimal ambient declaration for wavedrom (the digital-waveform/timing-diagram
 * renderer). The package ships no TypeScript types and is only ever lazily
 * `import()`-ed in TimingDiagramNode, where the result is narrowed to the small
 * surface we use, so we keep this intentionally loose (mirrors the qrcode.react
 * / sql.js ambient modules).
 */
declare module 'wavedrom'
