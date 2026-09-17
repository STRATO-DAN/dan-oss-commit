<div align="center">

<img src="assets/dan-mark.svg" alt="[DAN] COMMIT" width="84" height="84">

# [DAN] COMMIT

**Reads your real diff, writes a real commit message. One command, on your own machine.**

[![CI](https://github.com/STRATO-DAN/dan-oss-commit/actions/workflows/ci.yml/badge.svg)](https://github.com/STRATO-DAN/dan-oss-commit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@strato-dan/commit.svg)](https://www.npmjs.com/package/@strato-dan/commit)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2e9e56.svg)](#dependencies)
[![docs](https://img.shields.io/badge/docs-README-blue.svg)](#use)
[![license](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

> **⚡ Zero install · zero runtime dependencies.** No `npm install`, no build step —
> `npx @strato-dan/commit` runs it and `npm test` tests it. Pure Node standard library (Node ≥ 18).
> The **Generate** button uses an API key you already have (env var, not an install); everything
> else works with no key. Full breakdown under [Dependencies](#dependencies).

Analyses your real staged (or unstaged) changes and writes a real commit message from the real
diff — not a template, not a guess. One command, no backend to deploy, runs entirely on your own
machine against your own git repo.

## Use

```bash
npx @strato-dan/commit
```

Run it inside any real git repository. The CLI prints a URL carrying your access token — open **that**
URL. It opens on `http://127.0.0.1:4870` (loopback only — never reachable from another machine) showing:

- the real repo/branch you're in
- the real diff about to be committed (staged changes if any exist, otherwise unstaged)
- a **Generate** button that sends that real diff to a real LLM and writes a real message
- a **Commit** button that runs the real `git commit` with whatever message is in the box —
  generated, edited, or written from scratch

## Examples

[`examples/read-diff-and-generate.mjs`](examples/read-diff-and-generate.mjs) uses this package's
own library functions directly (no UI, no server) to read a real diff and generate a real commit
message from it:

```bash
node examples/read-diff-and-generate.mjs            # against the current directory
node examples/read-diff-and-generate.mjs /path/to/repo   # against any other real git repo
```

### Worked example (no API key needed to follow along)

Create a throwaway repo, make a change, and run the example with **no API key set**. It prints the
real diff, then tells you plainly that it's skipping generation because no key is configured — it
never invents a message:

```bash
# a throwaway repo you can delete afterwards
mkdir /tmp/dan-commit-demo && cd /tmp/dan-commit-demo
git init -q -b main
git config user.email dev@example.com && git config user.name Dev
printf 'export function greet(name) {\n  return "Hello, " + name;\n}\n' > greet.js
git add -A && git commit -q -m "Add greet function"

# make a real change and stage it
printf 'export function greet(name) {\n  if (!name) return "Hello there";\n  return "Hello, " + name + "!";\n}\n' > greet.js
git add -A

# from a checkout of this repo, point the example at that repo
node examples/read-diff-and-generate.mjs /tmp/dan-commit-demo
```

Real output from exactly the steps above:

```
Repo: /tmp/dan-commit-demo
Branch: main

Real diff (staged), 241 chars:

diff --git a/greet.js b/greet.js
index 34bc9a3..226d3e8 100644
--- a/greet.js
+++ b/greet.js
@@ -1,3 +1,4 @@
 export function greet(name) {
-  return "Hello, " + name;
+  if (!name) return "Hello there";
+  return "Hello, " + name + "!";
 }


No ANTHROPIC_API_KEY or OPENAI_API_KEY set — skipping message generation.
This is the same honest message the real UI shows; nothing is fabricated here.
```

## Tests

Real unit + integration tests, run against a real temporary git repo (they shell out to the real
`git` binary rather than mocking it), on Node's own built-in test runner — no install step and no
dependencies to add:

```bash
npm test
```

Observed on the current tree: **20 tests, all passing** — including the security regression that proves
the content-addressed snapshot: the reviewed bytes changing moves the snapshot even when `git status`
does not, and a commit is bound to the reviewed tree even if the working tree changes after review.

```
# tests 20
# pass 20
# fail 0
```

## Requirements

- Node.js 18+
- A real `git` repository
- One of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set in your environment, for the Generate
  button. Everything else (reading the diff, committing) works without either key.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `DAN_OSS_COMMIT_PORT` | `4870` | Local port |
| `DAN_OSS_COMMIT_MODEL` | provider default | Model name passed to the API |

## Security model (v0.2.3)

This surface is a privileged Git-mutation and external-LLM control plane, so locality alone is not the
trust decision:

- **Bearer token on every `/api/` op** — auto-generated per run, handed to the dashboard in the launch URL,
  `DAN_OSS_COMMIT_TOKEN` override for agents/CI. Unauthenticated commit / generate / diff / status → **401**.
  A cross-origin page can't obtain the token, and a `text/plain` simple-POST is refused (**415**).
- **Content-addressed, snapshot-bound commit** — `/api/diff` returns a hash of the exact repo **tree**
  that would be committed: HEAD plus the git tree objects of the staged index and of the working tree
  after `git add -A` (computed against a throwaway index, so your real index is never touched). Because it
  hashes the tree, not `git status`, it changes whenever the reviewed **bytes** change — even if a file's
  status classification stays `M`. `/api/commit` re-checks it and **fails closed with 409** on any drift,
  then commits that **exact captured tree** via `git commit-tree` — so the committed tree is the reviewed
  tree even if another process changes the working tree between review and commit (no verify→commit TOCTOU).
- **HEAD compare-and-swap (0.2.2)** — the commit's ref update is bound to the exact HEAD the snapshot was
  captured on (`update-ref HEAD <new> <expectedOld>`). If HEAD moves between review and commit (another
  terminal, agent, or hook), git itself refuses the update and the commit **aborts with a clear error**
  instead of building on the reviewed parent and silently overwriting a concurrent commit.
- **Diff → LLM prompt-injection boundary (0.2.3)** — the repository diff is attacker-controllable and is
  sent to the model to generate the commit message. It's wrapped in a labeled, per-call random-token fence
  and presented as UNTRUSTED DATA; the system prompt explicitly forbids following any instruction that
  appears inside it. **Defense-in-depth, not a cure** — prompt injection isn't fully solvable by a fence
  alone; this stops the app from silently handing the model attacker-controlled repository text as if it
  were a trusted instruction, it does not guarantee the model can never be steered by sufficiently
  sophisticated injected content.
- **Serialized commits** (per-repo lock), **rate limits** (→429), **message validation** (control chars /
  oversize → 422), **real HTTP status codes** (401/409/415/422/429/5xx, never a false 2xx for a failure),
  and an **append-only audit** (`~/.dan-oss-commit/audit.log`) of commits / generate calls / auth failures.
- **Honest limits, stated directly (not left for a reader to infer):**
  - A process running as the **same OS user** can run `git` on the repo directly anyway, so it is inside
    the boundary by definition; the token defends the browser/CSRF vector and other OS users.
    OS-authenticated IPC and a per-principal identity model are out of scope for this local single-user tier.
  - **`commit-tree` bypasses git's normal porcelain.** `commit-msg`, `pre-commit`, and `pre-push` hooks
    configured in your repo do **not** run on the commit this tool creates, and git commit signing
    (GPG/SSH, even if configured via `commit.gpgsign`) is **not** applied automatically. If your workflow
    relies on those, this tool's commits will not carry them — sign or hook-verify separately if that
    matters to you.
  - **The crash window between the three git operations is narrow but real, not fully atomic.** The
    sequence is `commit-tree` → `update-ref` (CAS-bound, see above) → `reset --mixed`. If `commit-tree`
    succeeds and `update-ref` then aborts (the CAS check failed), the created tree/commit objects are
    simply unreachable — nothing is added to your branch history, HEAD is untouched. If `update-ref`
    succeeds and the following `reset --mixed` then fails (e.g. the process is killed at that exact
    instant), HEAD has already moved to the new commit but your working tree/index may not yet reflect
    it — run `git status` and `git reset --mixed HEAD` by hand to resolve that specific, narrow window.
  - **The diff is sent to your configured LLM provider as-is when you click Generate.** No secret-scanning
    or redaction is performed on the diff before it's sent — if your uncommitted changes contain a
    credential or secret, review the diff yourself before clicking Generate, the same way you would
    before running `git add -A` on anything.
  - **Rate limits bound request *initiation*, not necessarily total outstanding resource consumption**
    while multiple slow LLM calls are in flight — a real limitation for anyone relying on it as a hard
    resource cap rather than an abuse deterrent.
  - **The audit log is append-only by convention, not by cryptographic guarantee.** `~/.dan-oss-commit/audit.log`
    is a plain local file — a process with filesystem access to it can edit or truncate past entries
    undetected. Treat it as a debugging/ops trail, not as forensic proof against a local attacker who
    already has filesystem access.

## What it never does

- Never sends your diff anywhere except the LLM API you've configured, with your own key.
- Never serves a privileged API operation without the bearer token.
- Never commits a repository state different from the one you reviewed (snapshot fails closed on drift).
- Never stages files you didn't ask it to (only stages everything if you tick the box, and only
  when the diff shown was unstaged to begin with).
- Never fabricates a commit message when no API key is set — it tells you plainly instead.
- Never listens on anything but `127.0.0.1`.

## When to use this

- **Best fit**: you want a real, fast, drafted commit message from your actual diff, without
  standing up a backend or sending anything anywhere except the LLM API you already have a key
  for. Reading the diff and committing work with zero setup even without a key.
- **Best fit**: you already have an Anthropic or OpenAI key for other work and want your commit
  messages written from real content instead of typed from memory or left as `wip`.

**Honest flip side**: if you want commit-message generation with *no* external API call at all —
not even opt-in — this isn't the right fit today; there's no local/offline model option. If you
need multi-provider comparison (generate from both Anthropic and OpenAI and pick), that's also not
built — `configuredProvider()` picks one deterministically, it doesn't call both.

## Dependencies

**Runtime dependencies: none.** Pure Node standard library — nothing to install to run it or test it.

| | |
|---|---|
| **Runtime dependencies** | **0** — Node standard library only |
| **Install to run** | none — `npx @strato-dan/commit` |
| **Install to test** | none — `npm test` uses Node's built-in test runner |
| **Node** | ≥ 18 |
| **API key** | `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` — only for the **Generate** button, and it's your own existing key as an env var, not an installed package. Reading the diff and committing need no key. |
| **Dev-only** | `husky` — pulled in only if you clone to contribute; never needed to use the tool |

## Project contents

| Path | What it is |
|---|---|
| `bin/dan-oss-commit.js` | The real CLI entry point — starts the server, opens your browser. |
| `src/server.js` | The loopback-only HTTP server and its routes. |
| `src/git.js` | Every real `git` call this tool makes (`execFile`, array args, never shell). |
| `src/llm.js` | The real Anthropic/OpenAI API call that generates a commit message. |
| `public/` | The plain HTML/CSS/vanilla-JS frontend served at `127.0.0.1`. |
| `examples/` | Runnable example code using the library functions directly, no UI. |
| `test/` | Real unit + integration tests (`npm test`, Node's own built-in test runner) — against a real temporary git repo, not a mocked one. |

## FAQ

**Does it work without an API key?** Yes — reading the real diff and committing both work with no
key at all. Only the **Generate** button needs one.

**Which LLM does it use?** Whichever of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` you have set. If
both are set, `configuredProvider()` picks one deterministically (see `src/llm.js`) — it doesn't
call both or let you choose per-request yet.

**Can I use a local/self-hosted model instead?** Not yet. This is a real, current limitation, not
a design decision to exclude it forever — a local-model provider is a reasonable future addition
if there's real demand for it.

**Does it work on Windows?** The server and git calls are cross-platform (Node stdlib + `git`
itself). The browser auto-open now uses the standard-correct Windows invocation — `cmd /c start ""
<url>` run through `execFile` with no shell (`start` is a `cmd` builtin, not an executable, so it
has to run via `cmd`; the empty `""` is the window-title argument `start` expects). Honest caveat:
this path hasn't yet been runtime-tested on a real Windows machine — it follows the
documented-correct approach, but it's flagged as unverified rather than claimed as tested. The tool
itself still starts and works regardless, since the browser open is best-effort and never the
reason it fails to launch.

**What happens with a merge conflict or a repo with zero commits yet?** It runs without crashing
and surfaces git's own real output either way. On a repo with zero commits yet (`git init` run,
nothing committed — an unborn HEAD), `currentBranch()` still reads the real branch name where
`rev-parse --abbrev-ref HEAD` would fail — a real bug found and fixed during this tool's own build,
and covered by a passing test, not an assumption. During a merge conflict, `git diff --staged`
reports the unmerged path exactly as git itself does, so the tool shows git's real state rather
than erroring.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to file an issue or submit a PR. Maintainers may use AI tools to help review
contributions — please don't include personal information in an issue, PR, or commit beyond
what's needed to describe the change.

## Releasing

See [RELEASING.md](RELEASING.md) —
the same version-bump/tag/publish process applies to every DAN-OSS tool, this one included.

## License

MIT (code) — see `LICENSE`. The "DAN" name and logo are trademarked and not covered by the MIT
grant — see `TRADEMARK.md`.

---

**[DAN] MEMORY SMASH** — the full codebase-memory engine this tool's commit-analysis capability
also lives inside — is coming soon.
