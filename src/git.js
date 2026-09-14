// Real git access only — every function here shells out to the user's own `git`, never
// re-implements git's own diff/status logic. execFile, not exec: arguments are passed as a
// real array, never interpolated into a shell string, so a branch/file name can never be
// read as a shell command.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 1024 * 1024 * 32 });
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

/** Real commit — stages everything first only if the caller explicitly asked for "unstaged"
 * source (so the message that was generated from those changes is what actually gets
 * committed); never silently stages files the diff shown to the user didn't cover. */
export async function realCommit(cwd, message, { stageAll } = {}) {
  if (stageAll) {
    await git(cwd, ["add", "-A"]);
  }
  await git(cwd, ["commit", "-m", message]);
  const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return { sha };
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
