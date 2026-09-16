// Real git access only — every function here shells out to the user's own `git`, never
// re-implements git's own diff/status logic. execFile, not exec: arguments are passed as a
// real array, never interpolated into a shell string, so a branch/file name can never be
// read as a shell command.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

async function git(cwd, args, extraEnv) {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 32,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return stdout;
  } catch (err) {
    // A real git failure (not a repo, git missing, bad ref) carries useful stderr — surface
    // it rather than swallowing it into a generic "something went wrong".
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function isRepo(cwd) {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** The real diff to commit — staged changes if any exist, otherwise all unstaged changes.
 * Never both silently combined: the caller is told which one it got, so "nothing staged, used
 * unstaged instead" is a visible fact, not a guess. */
export async function realDiff(cwd) {
  const staged = await git(cwd, ["diff", "--staged"]);
  if (staged.trim()) {
    return { diff: staged, source: "staged" };
  }
  const unstaged = await git(cwd, ["diff"]);
  return { diff: unstaged, source: unstaged.trim() ? "unstaged" : "none" };
}

export async function changedFiles(cwd, source) {
  const args = source === "staged" ? ["diff", "--staged", "--name-status"] : ["diff", "--name-status"];
  const out = await git(cwd, args);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

/** `symbolic-ref`, not `rev-parse --abbrev-ref HEAD` — the latter needs HEAD to resolve to a
 * real commit and fails on a genuinely valid state this tool must still handle: a fresh repo
 * with `git init` run and nothing committed yet (HEAD is unborn, but the branch name is real and
 * readable straight from .git/HEAD). */
export async function currentBranch(cwd) {
  try {
    return (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    return null; // detached HEAD or something symbolic-ref genuinely can't name — honest null, not a guess
  }
}

export async function hasCommits(cwd) {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// ── content-addressed repository snapshot (v0.2.1) ────────────────────────────────────────────────
//
// 🔴 WHY THIS IS A TREE HASH, NOT A STATUS HASH. A review is bound to the exact BYTES the user saw,
// so the snapshot must change whenever those bytes change. `git status --porcelain` reports only the
// classification of a change (` M a.txt`), never its content — so a file already shown as modified can
// have its bytes changed AGAIN with the status line unchanged, and a status-only hash would not move.
// (That was a real content-drift bypass in v0.2: with `git add -A`, the post-review bytes could be
// committed while the snapshot check still passed.) Instead we hash the actual git TREE objects that
// would be committed, computed against a TEMPORARY index so the real index is never touched.

/** Write the tree of a temp copy of the real index — optionally after `git add -A` into that copy
 *  (so it reflects everything a real `add -A` would stage, including untracked file CONTENT). Returns
 *  the tree SHA, or null in a state git can't write a tree for (e.g. an unresolved merge conflict). */
async function treeViaTempIndex(cwd, realIndexPath, addAll) {
  const tmp = path.join(os.tmpdir(), `dan-oss-commit-idx-${crypto.randomBytes(8).toString("hex")}`);
  try {
    try { await fsp.copyFile(realIndexPath, tmp); } catch { /* no index yet (fresh repo) → start empty */ }
    const env = { GIT_INDEX_FILE: tmp };
    if (addAll) await git(cwd, ["add", "-A"], env);
    return (await git(cwd, ["write-tree"], env)).trim();
  } catch {
    return null; // e.g. unmerged index — deterministic null; the porcelain component keeps the snapshot stable
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** The two candidate trees a commit could produce, plus HEAD and porcelain status:
 *   - stagedTree: the current index → what a staged-source commit (`stageAll:false`) would write.
 *   - workTree:   the index after `git add -A` → what an unstaged-source commit (`stageAll:true`) writes.
 * Both are content-addressed; the porcelain line is kept as a robust fallback for states git can't
 * tree-ify. This is stageAll-independent, so the snapshot taken at review time (`/api/diff`) equals the
 * one recomputed at commit time regardless of which commit operation is chosen. */
export async function repoTrees(cwd) {
  let head = null;
  try { head = (await git(cwd, ["rev-parse", "HEAD"])).trim(); } catch { /* unborn HEAD */ }
  const realIndexPath = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "index"])).trim());
  const stagedTree = await treeViaTempIndex(cwd, realIndexPath, false);
  const workTree = await treeViaTempIndex(cwd, realIndexPath, true);
  const status = await git(cwd, ["status", "--porcelain=v1", "-uall"]);
  return { head, stagedTree, workTree, status };
}

/** The content-addressed snapshot hash for a set of trees. Any change to HEAD, the staged tree, the
 *  working tree (incl. an already-modified file's bytes changing again), or untracked content moves it. */
export function snapshotOfTrees({ head, stagedTree, workTree, status }) {
  return crypto
    .createHash("sha256")
    .update(`${head || "unborn"}\n${stagedTree || "no-staged-tree"}\n${workTree || "no-work-tree"}\n${status}`)
    .digest("hex");
}

/** A content hash of the EXACT repository state a review is bound to. Used by /api/diff (review time)
 *  and re-checked at commit time; both go through the same tree computation, so they agree. */
export async function repoSnapshot(cwd) {
  return snapshotOfTrees(await repoTrees(cwd));
}

/** Commit an EXACT tree object as a new commit on HEAD — the reviewed tree itself, not a fresh
 *  `git add -A` re-read of the (possibly since-changed) working tree. This makes committed_tree ==
 *  approved_tree and closes the verify→stage→commit TOCTOU against another terminal/agent/hook: even
 *  if the working tree changes after the snapshot is verified, the commit is built from the captured
 *  tree, never the live one. The index is then synced to the new commit (working tree left as-is). */
export async function commitTree(cwd, tree, head, message) {
  if (!tree) throw new Error("cannot commit: no writable tree for the reviewed state (unresolved merge conflict?)");
  // Refuse a no-op commit, matching git's own fail-closed "nothing to commit" behavior — commit-tree
  // itself would happily create an empty commit, which is never what a review→commit flow wants.
  if (head) {
    const headTree = (await git(cwd, ["rev-parse", `${head}^{tree}`])).trim();
    if (headTree === tree) throw new Error("nothing to commit — the reviewed tree is identical to HEAD");
  } else if (!(await git(cwd, ["ls-tree", tree])).trim()) {
    throw new Error("nothing to commit — the reviewed tree is empty");
  }
  const ctArgs = head ? ["commit-tree", tree, "-p", head, "-m", message] : ["commit-tree", tree, "-m", message];
  const newSha = (await git(cwd, ctArgs)).trim();
  await git(cwd, ["update-ref", "-m", "dan-oss-commit: commit reviewed tree", "HEAD", newSha]);
  await git(cwd, ["reset", "--mixed", newSha]); // index → new HEAD; working tree untouched
  const sha = (await git(cwd, ["rev-parse", "--short", newSha])).trim();
  return { sha };
}

/** Convenience: capture the reviewed tree and commit exactly it. Used off the server request path
 *  (the server captures the tree once, verifies the snapshot against it, and commits that same tree,
 *  so verify and commit can never bind different bytes). */
export async function realCommit(cwd, message, { stageAll } = {}) {
  const trees = await repoTrees(cwd);
  const tree = stageAll ? trees.workTree : trees.stagedTree;
  return commitTree(cwd, tree, trees.head, message);
}
