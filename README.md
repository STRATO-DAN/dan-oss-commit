<div align="center">

<img src="assets/dan-mark.svg" alt="[DAN] COMMIT" width="84" height="84">

# [DAN] COMMIT

**Reads your real diff, writes a real commit message. One command, on your own machine.**

[![CI](https://github.com/STRATO-DAN/dan-oss-commit/actions/workflows/ci.yml/badge.svg)](https://github.com/STRATO-DAN/dan-oss-commit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dan-oss-commit.svg)](https://www.npmjs.com/package/dan-oss-commit)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2e9e56.svg)](#dependencies)
[![docs](https://img.shields.io/badge/docs-README-blue.svg)](#use)
[![license](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

> **⚡ Zero install · zero runtime dependencies.** No `npm install`, no build step —
> `npx dan-oss-commit` runs it and `npm test` tests it. Pure Node standard library (Node ≥ 18).
> The **Generate** button uses an API key you already have (env var, not an install); everything
> else works with no key. Full breakdown under [Dependencies](#dependencies).

Analyses your real staged (or unstaged) changes and writes a real commit message from the real
diff — not a template, not a guess. One command, no backend to deploy, runs entirely on your own
machine against your own git repo.

## Use

```bash
npx dan-oss-commit
```

Run it inside any real git repository. It opens `http://127.0.0.1:4870` (loopback only — never
reachable from another machine) showing:

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

Observed on the current tree: **12 tests, all passing**.

```
# tests 12
# pass 12
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

## What it never does

- Never sends your diff anywhere except the LLM API you've configured, with your own key.
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
| **Install to run** | none — `npx dan-oss-commit` |
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
