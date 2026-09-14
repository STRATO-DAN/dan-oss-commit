// Real tests against a real, temporary git repo — every function here shells out to the real
// `git` binary, so these tests do too, rather than mocking git's own behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRepo, realDiff, changedFiles, currentBranch, hasCommits, realCommit } from "../src/git.js";

const run = promisify(execFile);

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-test-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@test"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

test("isRepo is true for a real git repo, false for a plain directory", async () => {
  const repo = await makeRepo();
  const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-not-a-repo-"));
  try {
    assert.equal(await isRepo(repo), true);
    assert.equal(await isRepo(notRepo), false);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(notRepo, { recursive: true, force: true });
  }
});

test("currentBranch reads the real branch name even with zero commits yet (unborn HEAD)", async () => {
  const repo = await makeRepo();
  try {
    assert.equal(await currentBranch(repo), "main");
    assert.equal(await hasCommits(repo), false);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("realDiff reports 'none' when there are truly no changes", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
    const { source, diff } = await realDiff(repo);
    assert.equal(source, "none");
    assert.equal(diff.trim(), "");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("realDiff prefers staged changes over unstaged when both exist", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

    await fs.writeFile(path.join(repo, "a.txt"), "staged change\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "staged change\nplus unstaged\n");

    const { source, diff } = await realDiff(repo);
    assert.equal(source, "staged");
    assert.match(diff, /staged change/);
    assert.doesNotMatch(diff, /plus unstaged/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("changedFiles reports the real per-file status for the same source realDiff used", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
    // A real unstaged MODIFICATION to a tracked file — `git diff` (and so `realDiff`/
    // `changedFiles`) never sees a brand-new untracked file at all, only tracked changes.
    await fs.writeFile(path.join(repo, "a.txt"), "hello\nplus a real change\n");
    const { source } = await realDiff(repo);
    assert.equal(source, "unstaged");
    const files = await changedFiles(repo, source);
    assert.deepEqual(files, [{ status: "M", path: "a.txt" }]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("realCommit only stages everything when explicitly told to, and returns a real sha", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    const { sha } = await realCommit(repo, "first commit", { stageAll: true });
    assert.match(sha, /^[0-9a-f]{7,}$/);
    assert.equal(await hasCommits(repo), true);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("a git failure (e.g. committing with nothing staged) surfaces a real, readable error", async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(() => realCommit(repo, "nothing to commit"), /git commit .* failed/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
