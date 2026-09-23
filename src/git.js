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

// ── hostile-repository hardening (v0.2.4) ─────────────────────────────────────────────────────────
//
// 🔴 A repository is untrusted input. Merely READING it (/api/diff, the snapshot) must never become
// code execution. Git will happily run an arbitrary command out of a repo's OWN .git/config on a plain
// status/diff/add:
//   • core.fsmonitor = <cmd>            → runs on essentially every index-reading command.
//   • filter.<name>.clean|smudge|process = <cmd>, routed by an in-tree .gitattributes → runs when
//     git converts worktree↔blob (add, and the worktree/index comparison inside diff and status).
//   • diff.external / a textconv driver → runs while producing a content diff.
// A command-line `-c` overrides whatever the repo's config says, so we pin the fsmonitor to inert and
// neutralize every configured filter to empty; content diffs additionally pass --no-ext-diff/--no-textconv.
// This keeps the tool's own git invocations honest regardless of what the cloned repo tries to smuggle in.

const _filterOverridesCache = new Map(); // resolved cwd -> { flags, at }
const FILTER_CACHE_TTL_MS = 5000;

/** Enumerate every configured git filter (repo-local + global) and build `-c filter.<name>.<op>=`
 *  overrides that disable each clean/smudge/process command. A pure `git config` read triggers no
 *  filter and no fsmonitor, so this is itself safe to run against a hostile repo.
 *  FINDING 10 fix: never trust a stale memo — TTL 5s, then re-enumerate, so a config change at T1
 *  cannot outlive its mitigation at T2. */
async function filterOverrides(cwd) {
  const key = path.resolve(cwd);
  const cached = _filterOverridesCache.get(key);
  if (cached && (Date.now() - cached.at) < FILTER_CACHE_TTL_MS) return cached.flags;
  let flags = [];
  try {
    const { stdout } = await run(
      "git",
      ["-c", "core.fsmonitor=", "-c", `core.hooksPath=${NO_HOOKS_PATH}`, "config", "--name-only", "--get-regexp", "^filter\\."],
      { cwd, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    flags = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((k) => /\.(clean|smudge|process)$/.test(k))
      .flatMap((k) => ["-c", `${k}=`]);
  } catch {
    flags = []; // not a repo, or no filters configured — nothing to neutralize
  }
  _filterOverridesCache.set(key, { flags, at: Date.now() });
  return flags;
}

// REAL FINDING (external review, 2026-09-23): the hardening above neutralizes fsmonitor and
// filters, but NOT core.hooksPath -- a repo's own .git/hooks/post-index-change fires on nearly
// every index read (including /api/diff, which merely SHOWS a diff), and reference-transaction
// fires on commit. Both are real, arbitrary-code-execution paths from a hostile repo the README
// promises can't happen. Fixed the same way as fsmonitor/filters: a `-c` override on every call.
// Empirically confirmed (not assumed): pointing core.hooksPath at a path that does not exist
// causes git to silently find no hook scripts there and proceed normally -- no error, no crash,
// exactly the same "safe no-op" shape as `core.fsmonitor=` already relies on.
const NO_HOOKS_PATH = "/dev/null/dan-oss-commit-hooks-disabled";

async function git(cwd, args, extraEnv) {
  // Static + per-repo hardening prepended to EVERY git call this module makes.
  const hardening = ["-c", "core.fsmonitor=", "-c", `core.hooksPath=${NO_HOOKS_PATH}`, ...(await filterOverrides(cwd))];
  try {
    const { stdout } = await run("git", [...hardening, ...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 32,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return stdout;
  } catch (err) {
    // A real git failure (not a repo, git missing, bad ref) carries useful stderr — surface
    // it rather than swallowing it into a generic "something went wrong". The original args (not the
    // hardening flags) are echoed, so the error stays readable.
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

// REAL FINDING (external review, 2026-09-23): `git diff` (staged or not) never shows untracked
// files at all -- not their name, not their content. But a `stageAll:true` commit runs `git add
// -A` first, which DOES stage and commit untracked file content (see treeViaTempIndex above). The
// result: a secret sitting in a brand-new, never-`git add`ed file was invisible in the reviewed
// diff AND invisible to the secret scanner (which only ever sees this function's return value),
// yet could still land in the commit. Fixed by synthesizing a real diff for each untracked file
// via `git diff --no-index` against /dev/null (the real git binary renders the hunks — no
// reimplementation of diff formatting) and folding it into the SAME diff text everything else
// flows through, so review and the secret scanner both see it.
async function untrackedDiff(cwd) {
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).trim();
  if (!untracked) return "";
  const hardening = ["-c", "core.fsmonitor=", "-c", `core.hooksPath=${NO_HOOKS_PATH}`, ...(await filterOverrides(cwd))];
  const parts = [];
  for (const p of untracked.split("\n").filter(Boolean)) {
    try {
      // --no-index exits 0 only when the two sides are identical, which never happens here (one
      // side is always /dev/null) -- so this always "fails" in execFile's eyes; real stdout is
      // still on the rejected error, which is the actual diff we want.
      const { stdout } = await run(
        "git",
        [...hardening, "diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", p],
        { cwd, maxBuffer: 1024 * 1024 * 32, env: process.env },
      );
      parts.push(stdout);
    } catch (err) {
      // A real diff (exit 1, the expected case) still carries its stdout on the error object.
      // Only a genuine failure with no stdout at all (e.g. a permission error) skips this one
      // file rather than failing the whole diff for every other real change.
      if (typeof err.stdout === "string" && err.stdout) parts.push(err.stdout);
    }
  }
  return parts.join("");
}

/** The real diff to commit — staged changes if any exist, otherwise all unstaged changes plus
 * untracked file content. Never both silently combined: the caller is told which one it got, so
 * "nothing staged, used unstaged instead" is a visible fact, not a guess. */
export async function realDiff(cwd) {
  // --no-ext-diff/--no-textconv: never let a repo's diff.external or a textconv driver execute while
  // we render its own diff (part of the hostile-repo hardening above).
  const staged = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--staged"]);
  if (staged.trim()) {
    return { diff: staged, source: "staged" };
  }
  const unstaged = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv"]);
  const untracked = await untrackedDiff(cwd);
  const diff = unstaged + untracked;
  return { diff, source: diff.trim() ? "unstaged" : "none" };
}

/** The exact diff text for whichever tree a commit request asks to commit — used to run the
 * secret scanner on the COMMIT path itself (previously only `llm.js`'s optional generate path
 * ever called detectSecrets, so a user who wrote their own message and skipped Generate could
 * commit a secret with no scan at all). Independent of `realDiff`'s staged-vs-unstaged auto-
 * detection: `stageAll` here is the same real flag that decides which tree `commitTree` writes
 * (workTree vs stagedTree), so the scanned text always matches the tree actually being committed,
 * including staged content when a caller sets stageAll:true alongside existing staged changes. */
export async function diffForCommit(cwd, stageAll) {
  const staged = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--staged"]);
  if (!stageAll) return staged;
  const unstaged = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv"]);
  const untracked = await untrackedDiff(cwd);
  return staged + unstaged + untracked;
}

export async function changedFiles(cwd, source) {
  const args = source === "staged"
    ? ["diff", "--no-ext-diff", "--no-textconv", "--staged", "--name-status"]
    : ["diff", "--no-ext-diff", "--no-textconv", "--name-status"];
  const out = await git(cwd, args);
  const files = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
  // FINDING 01 fix: `diff --name-status` excludes untracked files, but `stageAll:true`
  // commits workTree (index after `add -A`, i.e. INCLUDING untracked content). The review
  // file list must therefore name untracked files explicitly, or the user authorizes a tree
  // they never saw. `ls-files --others` is a pure listing — no filter/smudge execution —
  // and runs under the same hardening wrapper.
  if (source !== "staged") {
    try {
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).trim();
      if (untracked) {
        for (const p of untracked.split("\n").filter(Boolean)) {
          if (!files.some((f) => f.path === p)) files.push({ status: "?", path: p });
        }
      }
    } catch { /* non-fatal: snapshot tree hash remains the binding authority */ }
  }
  return files;
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
  // Compare-and-swap the ref: bind the update to the SAME HEAD the reviewed tree was built on. If
  // another process (another terminal, agent, or hook) moved HEAD between the snapshot and now, git
  // refuses the update (old-value mismatch) and we abort — never overwrite a concurrent commit. The
  // internal mutex only serializes THIS server; git is free to be changed by anything else on the
  // machine, so the ref move itself must be conditional. Unborn HEAD (no first commit yet): the all-zero
  // oid is git's "this ref must not exist yet" sentinel, sized to the repo's hash format (sha1=40,
  // sha256=64) from newSha's own length so it works on either.
  const expectedOld = head || "0".repeat(newSha.length);
  try {
    if (!head) {
      const branch = await currentBranch(cwd);
      if (branch) {
        await git(cwd, ["update-ref", "-m", "dan-oss-commit: commit reviewed tree", `refs/heads/${branch}`, newSha, expectedOld]);
      } else {
        await git(cwd, ["update-ref", "-m", "dan-oss-commit: commit reviewed tree", "HEAD", newSha, expectedOld]);
      }
    } else {
      await git(cwd, ["update-ref", "-m", "dan-oss-commit: commit reviewed tree", "HEAD", newSha, expectedOld]);
    }
  } catch (err) {
    // update-ref IS the compare-and-swap. If it fails, HEAD never moved and nothing landed on the
    // branch (the commit-tree object is simply unreachable) — safe to abort with a real error.
    throw new Error(
      "HEAD moved since the reviewed snapshot was captured — aborting to avoid overwriting concurrent " +
        "work (the verify→commit HEAD-drift TOCTOU). Re-review against current HEAD and retry. " +
        `(${err.message})`,
    );
  }
  // 🔴 C1 — past this line the commit is DURABLE: update-ref has moved HEAD to newSha. The reset below
  // only resyncs the index/worktree to the new HEAD; it is NOT the commit. If it fails (e.g. another
  // process holds .git/index.lock at this instant), the commit still happened and HEAD still points at
  // it. We must therefore report the truth — the real sha plus a warning that the index needs a manual
  // resync — never raise as if nothing was committed. `rev-parse` needs no index lock, so it is safe here.
  const sha = (await git(cwd, ["rev-parse", "--short", newSha])).trim();
  // 🔴 C2 — commit-tree deliberately bypasses git's porcelain: no commit-msg/pre-commit/pre-push hook
  // runs on this commit, and commit.gpgsign signing is NOT applied. Surfaced on every result so a caller
  // is never misled into thinking a hook validated or a signature covers this commit.
  const result = { sha, hooksBypassed: true, signed: false, indexResynced: true };
  try {
    await git(cwd, ["reset", "--mixed", newSha]); // index → new HEAD; working tree untouched
  } catch (err) {
    result.indexResynced = false;
    result.warning =
      `commit ${sha} landed on HEAD, but syncing the index/working tree to it failed — ` +
      `run \`git reset --mixed HEAD\` by hand to resync. (${err.message})`;
  }
  return result;
}

/** Convenience: capture the reviewed tree and commit exactly it. Used off the server request path
 *  (the server captures the tree once, verifies the snapshot against it, and commits that same tree,
 *  so verify and commit can never bind different bytes). */
export async function realCommit(cwd, message, { stageAll } = {}) {
  const trees = await repoTrees(cwd);
  const tree = stageAll ? trees.workTree : trees.stagedTree;
  return commitTree(cwd, tree, trees.head, message);
}
