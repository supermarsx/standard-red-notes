// Structured logging without secrets. All log lines are JSON on stderr so the
// surrounding agent loop output (stdout) stays clean for piping.

export type LogLevel = "debug" | "info" | "warn" | "error";

let level: LogLevel = (process.env.OPENCLAW_LOG_LEVEL as LogLevel) ?? "info";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function setLevel(next: LogLevel): void {
  level = next;
}

function emit(
  lvl: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (order[lvl] < order[level]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: lvl,
    msg,
    ...fields,
  });
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};
