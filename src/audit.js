// [DAN] COMMIT — append-only audit (v0.2.4). One JSONL line per security-relevant event: commits, generate
// (external-LLM) calls, auth failures, and stale-snapshot rejections. Written to ~/.dan-oss-commit/audit.log
// — NEVER inside the repo working tree (this tool commits that tree; its own audit trail must not become part
// of a commit). Best-effort: an audit failure never fails the operation, but it is surfaced once so a broken
// trail is not silent. Override the location with DAN_OSS_COMMIT_AUDIT.
//
// 🔴 C5 — the trail is now tamper-EVIDENT, not append-only by mere convention. Each line carries the hash of
// the previous line and its own hash over (prevHash + the record). Any in-place edit, reorder, or deletion of
// a past entry breaks the chain and is caught by verifyAudit(). The file is created owner-only (0600) and each
// line is fsync'd before the write is considered done, so a crash right after a commit can't silently drop
// that commit's audit line. This does NOT stop a local attacker who already has filesystem access from
// truncating the whole tail and re-chaining a forgery — that's out of scope for a single-user local tool —
// but it does turn a silent edit into a detectable one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const GENESIS = "dan-oss-commit-audit-chain-v1";

function chainHash(prevHash, serializedRecord) {
  return crypto.createHash("sha256").update(prevHash).update("\n").update(serializedRecord).digest("hex");
}

/** Seed the running chain from the last line already on disk, so it continues unbroken across process
 *  restarts. A missing/empty/garbled tail starts fresh at GENESIS (still internally consistent). */
function lastHashOf(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) return GENESIS;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last.hash === "string" && last.hash ? last.hash : GENESIS;
  } catch {
    return GENESIS;
  }
}

export function makeAudit() {
  const file = process.env.DAN_OSS_COMMIT_AUDIT || path.join(os.homedir(), ".dan-oss-commit", "audit.log");
  let warned = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
  // Tighten an already-existing log to owner-only. Newly-created files get 0600 from the open() below;
  // this covers a log written by an older version (or a fresh 0644 from a prior umask).
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not present yet, or not ours — nothing to tighten */
  }
  let prevHash = lastHashOf(file);

  // Returns true/false so a caller can surface "did this event actually get recorded?" in its own
  // response — the write itself still never throws and never blocks the real operation (an audit
  // failure was always meant to degrade the audit trail, not the security-relevant action it describes).
  return function audit(event) {
    try {
      const record = { ts: new Date().toISOString(), ...event };
      const serialized = JSON.stringify(record);
      const hash = chainHash(prevHash, serialized);
      const line = JSON.stringify({ ...record, prev: prevHash, hash }) + "\n";
      // Open owner-only, append, and fsync so the security event is durably on disk before we advance.
      const fd = fs.openSync(file, "a", 0o600);
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      prevHash = hash; // advance the chain only after a durable write
      return true;
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(`[DAN] COMMIT: audit write failed (events not being recorded): ${err.message}`);
      }
      return false;
    }
  };
}

/** Verify a log's hash-chain end to end. Each line's `prev` must equal the previous line's `hash`, and
 *  each line's `hash` must equal chainHash(prev, record) where record is the line minus its prev/hash
 *  fields — so any altered, reordered, deleted, or injected past entry is detected. Returns
 *  { ok, entries, brokenAt, reason }; a missing or empty log is a consistent (ok:true) empty chain. */
export function verifyAudit(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, entries: 0, brokenAt: null, reason: "no audit log" };
  }
  const lines = raw.split("\n").filter(Boolean);
  let prevHash = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i, reason: "line is not valid JSON" };
    }
    const { prev, hash, ...record } = obj;
    if (prev !== prevHash) {
      return { ok: false, entries: lines.length, brokenAt: i, reason: "chain break: prev does not match the previous line's hash" };
    }
    if (chainHash(prevHash, JSON.stringify(record)) !== hash) {
      return { ok: false, entries: lines.length, brokenAt: i, reason: "hash mismatch: this line's content was altered" };
    }
    prevHash = hash;
  }
  return { ok: true, entries: lines.length, brokenAt: null, reason: "chain intact" };
}
