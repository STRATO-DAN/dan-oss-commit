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
import { makeAudit } from "../src/audit.js";
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
