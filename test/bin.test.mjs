// Regression tests for the launcher CLI flags (--version / --help / -h / --json) and the two
// clean-exit startup-failure paths (port already in use, unusable data directory). These flags shipped
// in 0.6.0 but had no direct coverage; this file spawns the REAL bin and asserts its exact output and
// exit codes so a future refactor can't silently change the contract.
//
// Node's built-in runner only, stdlib only — zero new dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "dan-oss-commit.js");
// The bin reports its own package version; read it the same way the bin does so the assertion tracks
// the real value instead of a hard-coded string.
const PKG_VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;

async function mkTmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Spawn the real bin and resolve once it exits, with everything it wrote. Used for the paths that
// print-and-exit (flags, startup failures); a run that never exits trips the timeout instead.
function runToExit(args, { cwd = HERE, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`bin did not exit in time. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 8000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("--version prints the package version and exits 0", async () => {
  const r = await runToExit(["--version"]);
  assert.equal(r.code, 0);
  // The bin writes exactly `readVersion() + "\n"` to stdout and nothing else.
  assert.equal(r.stdout, `${PKG_VERSION}\n`);
  assert.equal(r.stderr, "");
});

test("--help prints usage and exits 0", async () => {
  const r = await runToExit(["--help"]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^dan-oss-commit /); // banner leads with the tool name + version
  assert.match(r.stdout, /\nUsage:\n/);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /--version/);
  assert.match(r.stdout, /--help, -h/);
  assert.ok(r.stdout.includes(PKG_VERSION), "help banner names the version");
});

test("-h is an alias for --help", async () => {
  const [h, long] = await Promise.all([runToExit(["-h"]), runToExit(["--help"])]);
  assert.equal(h.code, 0);
  assert.equal(h.stdout, long.stdout); // identical help text
});

test("an unknown option is a usage error (exit 2, stderr only)", async () => {
  const r = await runToExit(["--bogus"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown option '--bogus'/);
  assert.match(r.stderr, /--help/); // points the user at help
});

test("--json prints exactly one clean JSON object with no token on stdout", async () => {
  const dir = await mkTmp("dan-oss-commit-bin-json-");
  const dataDir = path.join(dir, "audit");
  const auditFile = path.join(dataDir, "audit.log");
  const token = "TOKEN-must-not-leak-9f8e7d6c";
  const child = spawn(process.execPath, [BIN, "--json"], {
    cwd: dir,
    env: {
      ...process.env,
      // The bin reads DAN_OSS_COMMIT_PORT via `Number(env) || 4870`, so "0" is falsy and resolves to the
      // default port 4870 — that is the value the JSON below is expected to report.
      DAN_OSS_COMMIT_PORT: "0",
      DAN_OSS_COMMIT_OPEN: "0", // headless: no browser opener; helper text (with the token) goes to stderr
      DAN_OSS_COMMIT_AUDIT: auditFile,
      DAN_OSS_COMMIT_TOKEN: token,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  try {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no JSON line on stdout. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)),
        8000,
      );
      child.stdout.on("data", () => {
        const nl = stdout.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(stdout.slice(0, nl));
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(`bin exited before printing JSON. stderr=${JSON.stringify(stderr)}`));
      });
    });

    // stdout is exactly ONE JSON object and nothing else (the "auto-open disabled" note is on stderr).
    assert.equal(stdout.trim(), line.trim(), "stdout carries only the single JSON line");
    const obj = JSON.parse(line);
    assert.deepEqual(Object.keys(obj).sort(), ["dataDir", "mode", "port", "url"]);
    assert.equal(typeof obj.port, "number");
    assert.equal(obj.port, 4870); // Number("0") || 4870 → 4870
    assert.equal(obj.url, `http://127.0.0.1:${obj.port}`);
    assert.equal(obj.mode, "headless"); // DAN_OSS_COMMIT_OPEN=0
    assert.equal(obj.dataDir, dataDir);

    // C7: the access token must never reach stdout — not the value, not a field.
    assert.ok(!stdout.includes(token), "the access token must not appear on stdout");
    assert.ok(!/token|secret/i.test(stdout), "stdout carries no token/secret field");
  } finally {
    child.kill("SIGINT");
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.on("exit", finish);
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish(); }, 2500);
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startup fails cleanly (exit 1, one-line stderr, no stack) when the port is in use", async () => {
  const dir = await mkTmp("dan-oss-commit-bin-port-");
  const auditFile = path.join(dir, "audit", "audit.log");
  // Occupy a real ephemeral port ourselves, then hand the bin that exact port so the bind is guaranteed
  // to collide regardless of what else is running on the machine.
  const blocker = net.createServer();
  const busyPort = await new Promise((resolve) =>
    blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)),
  );
  try {
    const r = await runToExit([], {
      cwd: dir,
      env: { DAN_OSS_COMMIT_PORT: String(busyPort), DAN_OSS_COMMIT_OPEN: "0", DAN_OSS_COMMIT_AUDIT: auditFile },
    });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /already in use/);
    assert.match(r.stderr, new RegExp(`port ${busyPort}`));
    // One clean line, never a raw stack trace.
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.ok(!/\n\s+at\s/.test(r.stderr), "no stack frames in the error output");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startup fails cleanly (exit 1, one-line stderr) when the data directory is unusable", async () => {
  const dir = await mkTmp("dan-oss-commit-bin-datadir-");
  // Make the audit dir's parent a regular FILE, so mkdirSync of the data dir fails (ENOTDIR).
  const notADir = path.join(dir, "not-a-dir");
  await fs.writeFile(notADir, "x");
  const auditFile = path.join(notADir, "sub", "audit.log");
  try {
    const r = await runToExit([], {
      cwd: dir,
      env: { DAN_OSS_COMMIT_PORT: "0", DAN_OSS_COMMIT_OPEN: "0", DAN_OSS_COMMIT_AUDIT: auditFile },
    });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /data directory is not usable/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.ok(!/\n\s+at\s/.test(r.stderr), "no stack frames in the error output");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
