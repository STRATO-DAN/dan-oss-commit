// C7: the CLI entry point must not leak the access token to stdout on its normal path. Spawns the real
// bin, with a no-op opener so no browser launches and the fallback (the one path allowed to print the
// token) never fires, and asserts the token never appears in stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dan-oss-commit.js");

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-cli-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@test"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

test("C7: the access token is not printed to stdout on the normal (browser-opened) path", async () => {
  const repo = await makeRepo();
  const token = "test-token-DO-NOT-LEAK-abc123xyz";
  const port = String(20000 + Math.floor(Math.random() * 20000));
  // DAN_OSS_COMMIT_OPENER=true → a real command that ignores its args and exits 0, so no browser opens
  // and the failure-only fallback that prints the token never runs.
  const child = spawn(process.execPath, [BIN], {
    cwd: repo,
    env: { ...process.env, DAN_OSS_COMMIT_TOKEN: token, DAN_OSS_COMMIT_PORT: port, DAN_OSS_COMMIT_OPENER: "true" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CLI did not start in time. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)),
        8000,
      );
      const check = () => {
        if (/Ctrl-C to stop/.test(stdout)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", check);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(/\[DAN\] COMMIT running/.test(stdout), "the CLI really started and printed its banner");
    assert.ok(!stdout.includes(token), "the access token must NOT appear anywhere in stdout on the normal path");
  } finally {
    child.kill("SIGINT");
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.on("exit", finish);
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish(); }, 2500);
    });
    await fs.rm(repo, { recursive: true, force: true });
  }
});
