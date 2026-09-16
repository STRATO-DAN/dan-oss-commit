// [DAN] COMMIT — append-only audit (v0.2). One JSONL line per security-relevant event: commits, generate
// (external-LLM) calls, auth failures, and stale-snapshot rejections. Written to ~/.dan-oss-commit/audit.log
// — NEVER inside the repo working tree (this tool commits that tree; its own audit trail must not become part
// of a commit). Best-effort: an audit failure never fails the operation, but it is surfaced once so a broken
// trail is not silent. Override the location with DAN_OSS_COMMIT_AUDIT.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeAudit() {
  const file = process.env.DAN_OSS_COMMIT_AUDIT || path.join(os.homedir(), ".dan-oss-commit", "audit.log");
  let warned = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
  return function audit(event) {
    try {
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(`[DAN] COMMIT: audit write failed (events not being recorded): ${err.message}`);
      }
    }
  };
}
