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

## Threat model — direct answers, including where the answer is "no"

This tool got a genuinely hard, 80-question external adversarial review. Roughly a quarter had
real fixes shipped in response (0.2.1–0.2.3, above). This section answers the rest directly — real
fixes where there's a proportionate one for a zero-dependency, single-user local tool (two shipped
in this pass: a hard timeout on the LLM call, and the audit log's success/failure now surfaced in
the API response instead of only in stderr — see `auditOk` above) — and an honest, stated boundary
everywhere else, rather than silence. Silence is what makes a security claim untrustworthy; a
disclosed limit does not.

**What the token actually is.** It authenticates *possession*, not a human, a person, or a browser
session — whoever holds the string can perform every privileged operation this tool exposes. There
is no cryptographic proof that a human clicked "Commit" versus a script that has the token doing
so. It's transported once, in the launch URL, because that's the one channel available to a
zero-install local CLI with no prior trust relationship to establish a session over; the same
reason it's process-lifetime by default (not persisted) unless you explicitly opt into
`DAN_OSS_COMMIT_TOKEN` for CI/agent use — "ephemeral" describes the *default*, not a guarantee that
holds once you've opted out of it. It is never put in `sessionStorage` or any other browser storage
— the dashboard reads it once from the URL into an in-memory JS variable and attaches it as a
header on each `/api/` call, so there's no persisted-storage read surface to defend at all, but the
URL-transport itself has real, named leak vectors: shell/terminal scrollback if the URL is ever
echoed, the OS process list while the launching command runs, and browser history if you ever
bookmark or revisit the dashboard tab instead of closing it — treat the launch URL itself as a
one-time credential, the same way you'd treat a magic sign-in link.

**Why "commit failed" can never mean HEAD already moved.** The ref update *is* the compare-and-swap
— `update-ref HEAD <new> <expectedOld>` either lands atomically (HEAD moved to the new commit, full
success) or git refuses it outright (HEAD untouched, the endpoint returns a real error). There's no
third state where the API can report failure after HEAD already changed, because git itself won't
perform a HEAD move that isn't backed by the exact expected prior value. What "success" means is
exactly that one atomic transition; it never means "some of the git operations ran."

**The four trust roots are the same principal, not four independent ones.** The bearer token, the
audit log's authority, the repository state, and (since commit-tree bypasses signing) the identity
behind any commit this tool creates are all, in the end, whoever is running this process as your OS
user. That's not an oversight the architecture is hiding — it's the honest shape of a local,
single-user tool. If you need those to be independently verifiable principals, this tool's tier
doesn't provide that.

**There is no capability separation.** Read-only diff inspection, LLM generation, commit creation,
and ref mutation all sit behind the one bearer-token check. Possess the token and you can do all
four; there's no narrower-scoped token for "just read the diff." Named directly because a
diagram of this tool draws exactly one gate in front of everything behind it, and that's accurate.

**Per-scenario: what still holds, stated plainly.**
| If this is compromised/malicious… | …this still holds | …this does not |
|---|---|---|
| Localhost trust itself (if this were ever reachable beyond `127.0.0.1`) | The bearer token is still required on every `/api/` op regardless of how the request arrived — it is not solely a "you're on loopback" check | The loopback bind is real defense-in-depth today (`Never listens on anything but 127.0.0.1`, above); this tool has no separate mechanism for a non-loopback deployment, so that scenario is out of scope, not silently assumed safe |
| The browser origin | The token can't be read by a different origin; a non-JSON POST is refused (415) | Nothing, once the token itself is obtained from *within* the origin — see "the browser" row below |
| The repository content (a diff) | The prompt-injection fence contains injected text as data, tested; it can only ever influence the *generated commit message string*, never which tree gets committed (that's computed independently, from real git objects, before the message is even generated) | The fence is not a proof against a sufficiently sophisticated model-steering attempt — defense-in-depth, not a cure |
| Local git configuration (hooks, signing config) | The committed tree's *content* is still the exact reviewed bytes (content-addressed, CAS-bound) | Hooks and signing configured in the repo do not run via this tool's commit path at all — see the honest limits above |
| Another local process, same OS user | Nothing — that process is already inside the trust boundary by definition (see "trust roots," above) | Everything; this is the one you can't defend against at this tier |
| The external LLM provider | The repository's real tree/commit path never depends on what the LLM returns — a malicious/compromised response can only become a bad commit *message*, generation is a 502 on any provider error | The message text itself, obviously — review what you're about to commit |
| A process crash at the worst instant | HEAD is CAS-bound (a torn commit-tree→update-ref never lands); a torn update-ref→reset-mixed leaves a real commit with a stale index, recoverable by hand (see the crash-window note above) | Nothing beyond that one specific narrow window — it is not fully transactional across all three steps |

**Which claims are enforced by code vs. only asserted in docs.** Enforced, verifiably, by a real
test today: bearer-token 401 on every `/api/` op, 415 on non-JSON Content-Type, snapshot-hash 409
on drift, HEAD-CAS abort on concurrent commit, control-character/oversize message 422, rate-limit
429, LLM-call timeout, and `auditOk` reflecting a real write outcome. Asserted in this document but
*not* independently enforced by a test today: hook/signing non-execution (true by construction —
`commit-tree` structurally cannot invoke them — but no regression test proves it stays true if the
commit path is ever refactored), and the full "if X is compromised" table above (each row's *code*
behavior is real; the table itself is documentation, not something CI checks against drift).

**Test coverage, honestly, not just "tests exist."** 35 real tests today. Covered with a real,
adversarial test: concurrent Git process racing a commit (HEAD-drift CAS), content-addressed
snapshot drift, a broken audit target under real HTTP load (both the pre-existing "never blocks
the operation" invariant and the new `auditOk` surfacing), a hung LLM provider (real abort, timed),
and the prompt-injection containment boundary. **Not tested, named directly rather than left
implicit:** a process-kill/crash simulated at the update-ref→reset-mixed boundary specifically (the
code path is reasoned about, above, not exercised by a real kill -9); a malicious git hook actually
firing and mutating state (moot only because hooks don't run via this path, not exercised);
repository-local git config changing between snapshot and commit; and a literal "browser session
replay" test (there's no session construct to replay — the token is a flat credential, tested as
one).

**The remaining specific questions, answered directly, not folded into the table above:**
- *Why treat the diff as untrusted only inside the LLM prompt, not throughout the whole pipeline?*
  Because outside the prompt, the diff is never *interpreted* — it's hashed (content-addressing),
  displayed (the dashboard), and committed as raw bytes. "Untrusted" matters specifically at the one
  point something *reads it as language*. If a future version adds anything else that interprets
  diff content as instructions, that new surface needs the same fencing — this isn't a one-time fix.
- *What stops a future agentic tool on the LLM path from turning today's prompt-injection issue into
  tool-execution?* Nothing architectural — today there is no tool-calling on this path at all, only
  text generation, so the blast radius is capped at the commit message string by the absence of
  tools, not by a designed capability boundary. Adding a tool call here would need its own real
  authorization step before this tool's threat model still holds; it would not inherit safety from
  the diff fence.
- *Why is an external LLM part of a local-first Git workflow at all?* It's opt-in, not structural —
  reading the diff and committing work fully without ever calling one; only the Generate button
  uses it. The trade is real (an external network dependency, using your own key) for a real
  benefit (a fast, drafted message from actual content); the honest answer to "why include it" is
  that a git tool with zero AI assistance was a *different*, less useful tool, and this one chose to
  offer it as strictly additive rather than mandatory.
- *What happens to sensitive content sent to the LLM provider — retention, logging?* That's the
  provider's own data policy, not this tool's to promise — it's your own API key, so your existing
  agreement with Anthropic/OpenAI governs it, the same as any other tool you point at that key.
- *Concurrent slow LLM calls, and an authenticated caller intentionally exhausting the process via
  expensive diffs?* Rate limits bound how many *new* requests start, not the resource cost of ones
  already in flight (stated above) — an authenticated local caller deliberately doing this is
  already inside the trust boundary (see the table above: "another local process, same OS user" is
  the one thing this tier doesn't defend against), so this is a real, named non-goal, not a missed
  case.
- *Why is the request body limit (40 MiB) dramatically larger than the diff size actually useful to
  the LLM (truncated at 60,000 characters)?* Because `/api/commit` and `/api/diff` carry a full
  repo snapshot hash plus commit message, not just a diff, and the body-size guard is one shared
  limit across every `/api/` endpoint, not an LLM-specific one — 40 MiB is the honest ceiling for
  "a real repo's diff could legitimately be this big," and the *LLM* path's own, much smaller
  60,000-character truncation is a separate, later cutoff applied only to what gets sent externally.
  **Named honestly, not hidden:** the full body — up to 40 MiB — is read into memory before that
  truncation happens, so an oversized `/api/generate` request does cost real memory proportional to
  what was sent, not to the 60,000 characters that eventually reach the model. This is a real,
  present resource-cost gap for a caller with the token (already covered by the "no capability
  separation" / "authenticated local caller" answers above — the caller is trusted, so this is not
  independently defended against beyond the flat 40 MiB ceiling).

**Is this a real security architecture, or safeguards around a single-user localhost trust model?**
The honest answer is the second one, and that's a legitimate, named design tier for what this tool
actually is — not a hedge. Every real defense above (bearer auth, snapshot-binding, CAS, the
prompt-injection fence, the LLM timeout) earns its keep against a browser-origin attacker or a
different OS user; none of them, individually or together, defend against another process running
as *you*. That's not a gap being talked around — it's the one invariant that has to be said in one
sentence, directly: **this tool's security model ends at your own OS user account, and begins
again only if you need something that account-level trust doesn't already give you for free.**

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
