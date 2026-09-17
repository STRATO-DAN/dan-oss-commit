// The audit log exists to answer "what actually happened" for security-relevant events — auth
// failures, stale-snapshot rejections, commits, generate failures. These tests assert entries are
// REALLY written to disk, not just that the code path that calls audit() doesn't throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeAudit, verifyAudit } from "../src/audit.js";
import { createServer } from "../src/server.js";

const run = promisify(execFile);

async function readAuditLines(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── makeAudit() in isolation ────────────────────────────────────────────────────────────────────

test("makeAudit writes a real JSONL line with a server-set timestamp for each event", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const file = path.join(dir, "audit.log");
  try {
    const write = (() => {
      const prev = process.env.DAN_OSS_COMMIT_AUDIT;
      process.env.DAN_OSS_COMMIT_AUDIT = file;
      const fn = makeAudit();
      if (prev === undefined) delete process.env.DAN_OSS_COMMIT_AUDIT; else process.env.DAN_OSS_COMMIT_AUDIT = prev;
      return fn;
    })();
    write({ action: "commit", sha: "abc1234" });
    write({ action: "auth-failure", path: "/api/status", method: "GET" });
    const lines = await readAuditLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].action, "commit");
    assert.equal(lines[0].sha, "abc1234");
    assert.ok(typeof lines[0].ts === "string" && !Number.isNaN(Date.parse(lines[0].ts)), "ts is a real, parseable timestamp the SERVER set");
    assert.equal(lines[1].action, "auth-failure");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("makeAudit is best-effort — a write failure never throws", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-fail-"));
  try {
    // Point the audit file AT a directory (not a file) — every appendFileSync to it must fail.
    const badTarget = path.join(dir, "is-a-dir");
    fsSync.mkdirSync(badTarget);
    const prev = process.env.DAN_OSS_COMMIT_AUDIT;
    process.env.DAN_OSS_COMMIT_AUDIT = badTarget;
    let audit;
    try { audit = makeAudit(); } finally {
      if (prev === undefined) delete process.env.DAN_OSS_COMMIT_AUDIT; else process.env.DAN_OSS_COMMIT_AUDIT = prev;
    }
    assert.doesNotThrow(() => audit({ action: "commit", sha: "x" }), "an unwritable audit target must never fail the caller's real operation");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── C5: the audit trail is tamper-evident (hash-chained), owner-only (0600), and fsync'd ───────────

function makeAuditAt(file) {
  const prev = process.env.DAN_OSS_COMMIT_AUDIT;
  process.env.DAN_OSS_COMMIT_AUDIT = file;
  try {
    return makeAudit();
  } finally {
    if (prev === undefined) delete process.env.DAN_OSS_COMMIT_AUDIT; else process.env.DAN_OSS_COMMIT_AUDIT = prev;
  }
}

test("C5: the hash-chain verifies intact, the log is owner-only (0600), and an edited past entry is detected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-c5-"));
  const file = path.join(dir, "audit.log");
  try {
    const write = makeAuditAt(file);
    assert.equal(write({ action: "commit", sha: "aaa1111" }), true);
    write({ action: "generate", provider: "anthropic" });
    write({ action: "auth-failure", path: "/api/status" });

    const intact = verifyAudit(file);
    assert.equal(intact.ok, true, `an untampered chain must verify (${intact.reason})`);
    assert.equal(intact.entries, 3);

    if (process.platform !== "win32") {
      const mode = fsSync.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `the audit log must be created owner-only, got 0${mode.toString(8)}`);
    }

    // Rewrite a PAST entry's payload in place (keeping its stored hash) — the chain must catch it.
    const lines = fsSync.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const forged = JSON.parse(lines[0]);
    forged.sha = "ffff999";
    lines[0] = JSON.stringify(forged);
    fsSync.writeFileSync(file, lines.join("\n") + "\n");

    const tampered = verifyAudit(file);
    assert.equal(tampered.ok, false, "an in-place edit of a past entry must break the chain");
    assert.equal(tampered.brokenAt, 0, "verifyAudit points at the exact tampered line");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("C5: the chain continues unbroken across separate audit sessions (process restarts)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-c5b-"));
  const file = path.join(dir, "audit.log");
  try {
    makeAuditAt(file)({ action: "commit", sha: "sess1aa" });
    // a fresh makeAudit() (as a new process would create) must seed from the last line and keep the chain
    makeAuditAt(file)({ action: "commit", sha: "sess2bb" });
    const v = verifyAudit(file);
    assert.equal(v.ok, true, `the chain must span both sessions (${v.reason})`);
    assert.equal(v.entries, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── real security events actually reach the audit log, over real HTTP ─────────────────────────────

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-http-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@test"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

function req(port, method, p, { token, body, contentType = "application/json" } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (data) headers["content-type"] = contentType;
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const stop = (server) => { server.closeAllConnections?.(); server.close(); };

async function startWithAudit(cwd, auditFile) {
  const prev = process.env.DAN_OSS_COMMIT_AUDIT;
  process.env.DAN_OSS_COMMIT_AUDIT = auditFile;
  const server = createServer({ cwd });
  if (prev === undefined) delete process.env.DAN_OSS_COMMIT_AUDIT; else process.env.DAN_OSS_COMMIT_AUDIT = prev;
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port, token: server.commitToken })),
  );
}

test("AUDIT: an unauthenticated request really produces an auth-failure entry on disk", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const auditFile = path.join(dir, "audit.log");
  const { server, port } = await startWithAudit(repo, auditFile);
  try {
    const r = await req(port, "GET", "/api/status");
    assert.equal(r.status, 401);
    const lines = await readAuditLines(auditFile);
    const entry = lines.find((l) => l.action === "auth-failure");
    assert.ok(entry, "the 401 must be reflected in the audit log, not just the HTTP response");
    assert.equal(entry.path, "/api/status");
  } finally {
    stop(server);
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AUDIT: a stale-snapshot commit rejection really produces a commit-rejected entry on disk", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const auditFile = path.join(dir, "audit.log");
  const { server, port, token } = await startWithAudit(repo, auditFile);
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "a.txt"], { cwd: repo });
    const diff = await req(port, "GET", "/api/diff", { token });
    await fs.writeFile(path.join(repo, "surprise.txt"), "not reviewed\n"); // drift after review
    const stale = await req(port, "POST", "/api/commit", { token, body: { message: "m", snapshot: diff.json.snapshot } });
    assert.equal(stale.status, 409);
    const entry = (await readAuditLines(auditFile)).find((l) => l.action === "commit-rejected");
    assert.ok(entry, "a fail-closed 409 must leave a real audit trail, not just a response the caller can ignore");
    assert.equal(entry.reason, "stale-snapshot");
  } finally {
    stop(server);
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AUDIT: a successful commit really produces a commit entry with the real sha on disk", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const auditFile = path.join(dir, "audit.log");
  const { server, port, token } = await startWithAudit(repo, auditFile);
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "a.txt"], { cwd: repo });
    const diff = await req(port, "GET", "/api/diff", { token });
    const ok = await req(port, "POST", "/api/commit", { token, body: { message: "m", snapshot: diff.json.snapshot } });
    assert.equal(ok.status, 200);
    const entry = (await readAuditLines(auditFile)).find((l) => l.action === "commit");
    assert.ok(entry);
    assert.equal(entry.sha, ok.json.sha, "the audited sha must be the REAL committed sha, not a copy of client input");
  } finally {
    stop(server);
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AUDIT: a real commit succeeds even when the audit target is unwritable, and honestly reports auditOk:false", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  // Same "point the audit file AT a directory" technique as the unit-level write-failure test
  // above, but exercised end-to-end over real HTTP through the real commit path — proving the
  // SERVER's own response, not just makeAudit() in isolation, honestly reflects the broken trail.
  const badTarget = path.join(dir, "is-a-dir");
  fsSync.mkdirSync(badTarget);
  const { server, port, token } = await startWithAudit(repo, badTarget);
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "a.txt"], { cwd: repo });
    const diff = await req(port, "GET", "/api/diff", { token });
    const result = await req(port, "POST", "/api/commit", { token, body: { message: "m", snapshot: diff.json.snapshot } });
    assert.equal(result.status, 200, "an unwritable audit target must never fail the real commit — same invariant as the unit test above");
    assert.ok(result.json.ok, "the commit itself must still be reported as a real success");
    assert.equal(result.json.auditOk, false, "but the caller must be able to SEE that the audit trail is broken, not just this process's own stderr");
    const headSha = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo })).stdout.trim();
    assert.equal(result.json.sha, headSha, "the commit really happened on disk regardless of the audit failure");
  } finally {
    stop(server);
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AUDIT: a real generate call reports auditOk:true when the audit target is healthy", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const auditFile = path.join(dir, "audit.log");
  const prevA = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: "Fix the widget" }] }) });
  const { server, port, token } = await startWithAudit(repo, auditFile);
  try {
    const r = await req(port, "POST", "/api/generate", { token, body: { diff: "diff --git a/x b/x" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.auditOk, true, "a healthy audit target must report auditOk:true, not just be silent about it");
  } finally {
    stop(server);
    global.fetch = realFetch;
    if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevA;
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AUDIT: an LLM-boundary failure (no key configured) really produces a generate-failed entry on disk", async () => {
  const repo = await makeRepo();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-audit-"));
  const auditFile = path.join(dir, "audit.log");
  const prevA = process.env.ANTHROPIC_API_KEY, prevO = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  const { server, port, token } = await startWithAudit(repo, auditFile);
  try {
    const r = await req(port, "POST", "/api/generate", { token, body: { diff: "diff --git a/x b/x" } });
    assert.equal(r.status, 502, "an upstream/config failure is a real 502, never a false 2xx with a fabricated message");
    const entry = (await readAuditLines(auditFile)).find((l) => l.action === "generate-failed");
    assert.ok(entry, "a failed generate call must be audited, not just returned to the caller and forgotten");
    assert.match(entry.reason, /No API key configured/);
  } finally {
    stop(server);
    if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA;
    if (prevO !== undefined) process.env.OPENAI_API_KEY = prevO;
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
