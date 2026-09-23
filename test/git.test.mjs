// Real tests against a real, temporary git repo — every function here shells out to the real
// `git` binary, so these tests do too, rather than mocking git's own behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRepo, realDiff, changedFiles, currentBranch, hasCommits, realCommit, repoSnapshot, repoTrees, commitTree } from "../src/git.js";

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
    // A real unstaged MODIFICATION to a tracked file — `git diff` alone never names a brand-new
    // untracked file (that's `changedFiles`'s own `ls-files --others` fallback below); `realDiff`
    // now folds untracked CONTENT in too (see the next test), but there is none here to fold.
    await fs.writeFile(path.join(repo, "a.txt"), "hello\nplus a real change\n");
    const { source } = await realDiff(repo);
    assert.equal(source, "unstaged");
    const files = await changedFiles(repo, source);
    assert.deepEqual(files, [{ status: "M", path: "a.txt" }]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// REAL FIX (external review, 2026-09-23): `git diff` on its own never shows untracked file content
// at all -- only `changedFiles`'s separate `ls-files --others` call named the file, with no bytes.
// `realDiff` now synthesizes and folds in a real diff for each untracked file, so the reviewed diff
// text (and anything that scans it, e.g. the secret gate) actually sees what a `stageAll:true`
// commit would include.
test("realDiff folds untracked file CONTENT into the diff text, not just tracked changes", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

    // A genuinely new, never-`git add`ed file — the exact case that used to be invisible.
    await fs.writeFile(path.join(repo, "new-file.txt"), "brand new untracked content\n");
    const { source, diff } = await realDiff(repo);
    assert.equal(source, "unstaged");
    assert.match(diff, /brand new untracked content/, "untracked file content must appear in the diff text");
    assert.match(diff, /new-file\.txt/, "the diff must name the untracked file it's showing");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// diffForCommit is what the server's commit-path secret scan actually reads — its output must
// track exactly which tree `stageAll` says is about to be committed, including the case a raw API
// caller could force (stageAll:true alongside pre-existing staged content), not just the UI's own
// (bypassable) restriction that the two never coexist.
test("diffForCommit(stageAll) reflects exactly the tree being committed, including staged+untracked together", async () => {
  const { diffForCommit } = await import("../src/git.js");
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

    await fs.writeFile(path.join(repo, "a.txt"), "hello\nstaged edit\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked content\n");

    const stagedOnly = await diffForCommit(repo, false);
    assert.match(stagedOnly, /staged edit/);
    assert.doesNotMatch(stagedOnly, /untracked content/, "stageAll:false must not scan content it won't commit");

    const withStageAll = await diffForCommit(repo, true);
    assert.match(withStageAll, /staged edit/, "stageAll:true still includes real staged content");
    assert.match(withStageAll, /untracked content/, "stageAll:true must also include untracked content it WILL commit");
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

test("committing with nothing to commit is refused with a readable error", async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(() => realCommit(repo, "nothing to commit"), /nothing to commit/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// ── the security invariant the snapshot exists to enforce ─────────────────────────────────────────

test("SECURITY: repoSnapshot is content-addressed — the reviewed BYTES changing moves the snapshot even when `git status` does not", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "SAFE\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "REVIEWED\n"); // status becomes ' M a.txt'
    const before = await repoSnapshot(repo);
    await fs.writeFile(path.join(repo, "a.txt"), "MALICIOUS\n"); // status STAYS ' M a.txt', bytes differ
    const after = await repoSnapshot(repo);
    const status = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: repo })).stdout.trim();
    assert.equal(status, "M a.txt", "the git status classification is unchanged between the two states");
    assert.notEqual(before, after, "but the content-addressed snapshot MUST change when the reviewed bytes do");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("SECURITY: a commit is bound to the reviewed tree — a concurrent change after review is NOT committed", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "SAFE\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "REVIEWED\n");
    const trees = await repoTrees(repo); // capture exactly what the user reviewed
    await fs.writeFile(path.join(repo, "a.txt"), "MALICIOUS\n"); // an external process changes it after review
    await commitTree(repo, trees.workTree, trees.head, "commit the reviewed tree");
    const committed = (await run("git", ["show", "HEAD:a.txt"], { cwd: repo })).stdout.trim();
    assert.equal(committed, "REVIEWED", "the committed bytes are the reviewed ones, never the concurrent change");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("SECURITY: HEAD drift is refused — a concurrent commit that moves HEAD after review aborts the commit (compare-and-swap), never overwriting it", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "SAFE\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "REVIEWED\n");
    const trees = await repoTrees(repo); // capture the reviewed state, incl. head = commit A

    // Another process commits, moving HEAD A → B AFTER the review snapshot was captured.
    await fs.writeFile(path.join(repo, "b.txt"), "concurrent work\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "concurrent commit by another process"], { cwd: repo });
    const headB = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    // Committing the reviewed tree bound to the now-stale head (A) must be REFUSED — the ref update is a
    // compare-and-swap, so it cannot silently overwrite the concurrent commit B.
    await assert.rejects(
      () => commitTree(repo, trees.workTree, trees.head, "commit the reviewed tree"),
      /HEAD moved since the reviewed snapshot/,
    );
    const headNow = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    assert.equal(headNow, headB, "the concurrent commit B must remain HEAD — the stale-based commit was refused, not committed over it");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// ── C1: the commit is durable once update-ref moves HEAD, even if the index resync then fails ──────
test("C1: a failed index resync after update-ref still reports the durable commit, never a lost-commit error", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "SAFE\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    const head0 = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await fs.writeFile(path.join(repo, "a.txt"), "REVIEWED\n");
    const trees = await repoTrees(repo);

    // Hold .git/index.lock: `git reset --mixed` (the index resync) fails, but commit-tree and update-ref
    // (which actually moves HEAD) still succeed — the exact window the finding describes.
    const lock = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lock, "");
    let result;
    try {
      result = await commitTree(repo, trees.workTree, trees.head, "commit the reviewed tree");
    } finally {
      await fs.rm(lock, { force: true });
    }

    const headNow = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    assert.notEqual(headNow, head0, "HEAD really moved to the new commit — it is durable");
    const shortNow = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo })).stdout.trim();
    assert.equal(result.sha, shortNow, "the reported sha is the real, durable HEAD — not raised as a failure");
    assert.equal(result.indexResynced, false, "the failed resync is reported honestly");
    assert.match(result.warning, /git reset --mixed HEAD/, "the caller is told how to resync by hand");
    assert.equal(result.hooksBypassed, true, "C2: hook-bypass is flagged on every commit result");
    assert.equal(result.signed, false, "C2: unsigned is flagged on every commit result");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("repoSnapshot also binds new untracked file content", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    const base = await repoSnapshot(repo);
    await fs.writeFile(path.join(repo, "new.txt"), "brand new\n"); // untracked
    assert.notEqual(base, await repoSnapshot(repo), "an untracked file's content is part of the snapshot");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// REAL FIX (external review, 2026-09-23, self-correction same day): `repoTrees()`'s workTree
// candidate used to be computed by running `git add -A` against a temp GIT_INDEX_FILE copy — but
// that specific combination (add + a temp index) was found to defeat this tool's own
// core.hooksPath neutralization (a genuine, empirically-reproduced git behavior: under
// GIT_INDEX_FILE, post-index-change ignores every config-override mechanism and still runs the
// real .git/hooks/post-index-change script). Rewritten to build the tree via pure object-database
// plumbing (hash-object/ls-tree/mktree) that never opens any index file at all — see the HOOKS
// test in security.test.mjs for proof that no longer fires the hook. This test proves the OTHER
// half: the rewrite must still produce the exact SAME tree a real `git add -A` would, including
// nested directories, a modified tracked file, a deleted tracked file, and a brand-new untracked
// file inside a brand-new nested directory — not just "doesn't crash".
test("SECURITY: repoTrees' workTree matches a real `git add -A`, byte-for-byte, including nested dirs/deletes/new-dirs", async () => {
  const repo = await makeRepo();
  const idxDir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-commit-parity-idx-"));
  try {
    await fs.mkdir(path.join(repo, "sub", "deep"), { recursive: true });
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await fs.writeFile(path.join(repo, "sub", "b.txt"), "b\n");
    await fs.writeFile(path.join(repo, "sub", "deep", "c.txt"), "c\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    // A modified tracked file, a deleted tracked file, and a new untracked file inside a NEW
    // nested directory — the exact shape a real `git add -A` has to get right.
    await fs.writeFile(path.join(repo, "a.txt"), "hello\nmodified\n");
    await fs.rm(path.join(repo, "sub", "b.txt"));
    await fs.mkdir(path.join(repo, "sub", "new"), { recursive: true });
    await fs.writeFile(path.join(repo, "sub", "new", "d.txt"), "new nested untracked\n");
    await fs.writeFile(path.join(repo, "e.txt"), "new top-level untracked\n");

    const trees = await repoTrees(repo);

    const tmpIndex = path.join(idxDir, "index");
    await run("git", ["add", "-A"], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
    const { stdout } = await run("git", ["write-tree"], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
    assert.equal(trees.workTree, stdout.trim(), "the plumbing-built workTree must be byte-identical to a real `git add -A`");
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(idxDir, { recursive: true, force: true });
  }
});
