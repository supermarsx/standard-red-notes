import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import type { AuditEntry } from "../mcp/session.js";
import { log } from "./log.js";
import { redactForAudit } from "./redact.js";

export function expandAuditPath(file: string): string {
  if (file === "~") return homedir();
  if (file.startsWith("~/") || file.startsWith("~\\")) {
    return resolve(homedir(), file.slice(2));
  }
  return file;
}

export function createAuditSink(file: string): (entry: AuditEntry) => void {
  const expanded = expandAuditPath(file);
  try {
    const created = mkdirSync(dirname(expanded), {
      recursive: true,
      mode: 0o700,
    });
    if (platform() !== "win32" && created !== undefined) {
      // Never chmod an existing shared parent such as /var/log. The final
      // directory receives 0700 when this call created any part of its chain.
      chmodSync(dirname(expanded), 0o700);
    }
  } catch (error) {
    log.warn("audit directory setup failed", { error: String(error) });
  }

  return (entry) => {
    let descriptor: number | undefined;
    try {
      try {
        const existing = lstatSync(expanded);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error(
            "audit path must be a regular file, not a link or special file",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      descriptor = openSync(
        expanded,
        constants.O_APPEND |
          constants.O_CREAT |
          constants.O_WRONLY |
          (platform() === "win32"
            ? 0
            : constants.O_NOFOLLOW | constants.O_NONBLOCK),
        0o600,
      );
      if (platform() !== "win32") {
        const opened = fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          (process.getuid && opened.uid !== process.getuid())
        ) {
          throw new Error(
            "audit file must be an owner-controlled regular file with one link",
          );
        }
        // Tighten an existing file before any new audit bytes are written.
        fchmodSync(descriptor, 0o600);
      }
      writeSync(
        descriptor,
        `${JSON.stringify(redactForAudit(entry))}\n`,
        undefined,
        "utf8",
      );
    } catch (error) {
      log.warn("audit append failed", { error: String(error) });
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // best effort
        }
      }
    }
  };
}
