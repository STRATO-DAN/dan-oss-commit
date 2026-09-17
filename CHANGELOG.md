# Changelog

All notable changes to `@strato-dan/commit` are documented here.
This project uses [semantic versioning](https://semver.org/).

## [0.4.0] — 2026-09-17

A second adversarial-audit pass, closing nine confirmed findings with real fixes (each covered by a
regression test that fails on the prior code and passes on this one). Some of these turn a previously
*documented* limitation into an enforced guarantee. Zero runtime dependencies, still.

### Security
- **Untrusted-repository hardening (C6).** A repository is untrusted input: `core.fsmonitor`, a
  `filter.<name>.clean/smudge/process` routed by an in-tree `.gitattributes`, or `diff.external`/a
  textconv driver can each make plain `git` run an arbitrary command out of the repo's own `.git/config`
  — so a plain `GET /api/diff` against a hostile clone was command execution. Every git invocation now
  pins `core.fsmonitor` to inert, neutralizes every configured filter to empty via command-line `-c`, and
  runs content diffs with `--no-ext-diff --no-textconv`. Regression test: a repo clean-filter/fsmonitor
  that writes a marker is proven **not** to run on `/api/diff`.
- **Truthful reporting of a durable-but-unsynced commit (C1).** The commit sequence is `commit-tree` →
  `update-ref` (CAS) → `reset --mixed`. Once `update-ref` moves HEAD the commit is durable, but a failing
  `reset` (e.g. a held `.git/index.lock`) previously surfaced as a bare `500 "failed"` with no audit line
  — implying, falsely, that nothing was committed. `/api/commit` now returns `200` with the real `sha`,
  `indexResynced: false`, and a `warning` to run `git reset --mixed HEAD`, and audits the event as
  `commit-partial`. Genuine pre-HEAD-move failures still return a real error, now also audited.
- **Hook/signing bypass disclosed on the API, not just in docs (C2).** Every `/api/commit` response now
  carries `hooksBypassed: true` and `signed: false`, so a caller can't be misled into assuming a repo
  hook validated or a signature covers a `commit-tree`-created commit.
- **Rate limit runs before auth (C3).** The rate check now precedes the bearer check, so the
  unauthenticated 401 path — which writes an audit line — is itself throttled; an unauthenticated flood
  can no longer drive unbounded audit writes.
- **Tamper-evident, owner-only audit log (C5).** `~/.dan-oss-commit/audit.log` is now hash-chained (each
  line carries the previous line's hash and its own), created `0600`, and fsync'd per line. A new exported
  `verifyAudit()` detects any in-place edit, reorder, or deletion of a past entry. (A local attacker who
  can truncate the whole tail and re-chain a forgery is still out of scope — detection of a *silent* edit
  is the guarantee.)
- **Message validator rejects Trojan-Source and invisible characters (C8).** Beyond C0 controls + DEL, a
  commit message is now rejected (422) if it contains bidirectional overrides/isolates (U+202A–202E,
  U+2066–2069), NEL (U+0085), line/paragraph separators (U+2028/2029), or a zero-width space (U+200B).
- **The access token is kept off stdout (C7).** The CLI no longer prints the token (or the token-bearing
  URL) to stdout on its normal path — it hands the URL to the browser directly and prints only the
  non-secret base address; the full URL is echoed only as a fallback when the browser can't be opened, or
  when auto-open is disabled. Auto-open is now controllable via `DAN_OSS_COMMIT_OPEN` /
  `DAN_OSS_COMMIT_OPENER`. Residual argv exposure to the process list is documented.
- **`/api/diff` captures the diff and its binding snapshot atomically (C9).** Both are now read inside the
  same commit mutex (from one `repoTrees` capture), so a concurrent commit on this server can't move the
  repository between the two reads.

### Changed
- **Request-body cap lowered from 40 MiB to a 256 KiB default (C4),** configurable via
  `DAN_OSS_COMMIT_MAX_BODY`, and enforced at read time (an oversized body is refused, not buffered whole).
  This bounds memory cost; it is not a policy on diff content.

### Added
- **Advisory secret-shape warning (C4).** `/api/generate` returns `secretWarning: true` when the diff
  looks like it carries a credential (AWS keys, provider API keys, PEM private-key headers, etc.) — a
  non-blocking heads-up before the diff leaves the machine. It never blocks, redacts, or alters the diff.
  A diff-content classification/policy gate remains a deliberate product decision, not shipped here.
- Documented every `DAN_OSS_COMMIT_*` environment variable (several were previously undocumented).

## [0.3.0] — 2026-09-17

Follow-through on the full external 80-question adversarial review — the two remaining items with a
proportionate real fix for this tool's tier, plus a direct, honest threat-model answer to everything
else the review raised (previously answered by ~26 of 80; now 0 left silent — some by fix, most by
explicit disclosure).

### Added
- **A hard timeout on the LLM call** (`DAN_OSS_COMMIT_LLM_TIMEOUT_MS`, default 60000ms). A provider
  that never responds previously hung the request indefinitely — real `AbortController`-based abort,
  read per-call so it's actually configurable, not cached at import time.
- **`auditOk` in the `/api/commit` and `/api/generate` responses.** The audit log was always
  best-effort (a write failure never blocks the real operation — unchanged, still tested), but the
  failure was previously visible only in this process's own stderr. The caller can now see whether
  the event was durably recorded.

### Documentation
- A full "Threat model" section: what the bearer token actually authenticates (possession, not
  identity); that the four trust roots (token, audit, repo state, signing identity) collapse to one
  principal; that there is no capability separation; a per-scenario "what still holds" table (browser
  compromised / repo malicious / local git config malicious / another local process / LLM compromised
  / crash at the worst instant); which claims are code-enforced vs. only asserted; an honest test-
  coverage account (what's exercised by a real adversarial test today vs. named-but-not-tested); and
  a direct answer to whether this is a real security architecture or safeguards around a single-user
  localhost trust model (the honest answer is the second one, stated as a legitimate design tier, not
  a hedge).

## [0.2.3] — 2026-09-17

### Security
- **Prompt-injection boundary on the diff → LLM path.** The repository diff is attacker-controllable and
  is sent to the model to generate the commit message. The diff is now wrapped in a labeled, per-call
  **random-token fence** and presented as UNTRUSTED DATA, and the system prompt explicitly forbids
  following any instruction that appears inside it (e.g. "ignore previous instructions", "reveal the
  prompt", "run a command"). Defense-in-depth, not a cure — prompt injection isn't fully solvable — but it
  stops the app from silently handing the model attacker-controlled repository text as if it were a
  trusted prompt.

## [0.2.2] — 2026-09-17

### Security
- **HEAD compare-and-swap on commit.** The reviewed-tree commit now binds its `update-ref` to the exact
  HEAD the snapshot was captured on. If another process (a second terminal, agent, or hook) moves HEAD
  between review and commit, git refuses the ref update and the commit **aborts with a clear error**
  instead of building on the reviewed parent and silently overwriting the concurrent commit. Closes the
  verify→commit HEAD-drift TOCTOU — the internal per-repo mutex only serializes this server, while git
  can be changed by anything else on the machine, so the ref move itself must be conditional. (0.2.1 bound
  the committed *tree* to the reviewed content; 0.2.2 binds the *ref move* to the reviewed HEAD.)

## [0.2.0] — 2026-09-16

### ⚠️ Security — please upgrade from 0.1.x

Addresses a security review. DAN COMMIT exposes a privileged Git-mutation and external-LLM control plane over
loopback; in 0.1.x the only trust decision was locality (loopback + a DNS-rebind guard), which proves *where* a
request came from, not *who* made it — and the commit was not bound to the reviewed repository state.

### Added
- **Bearer-token auth on every `/api/` op** — auto-generated per run (ephemeral, never written into the repo),
  handed to the dashboard in the launch URL, `DAN_OSS_COMMIT_TOKEN` override. Unauthenticated commit / generate /
  diff / status → **401**.
- **Content-Type enforcement** — POST must be `application/json` (**415**), so a `text/plain` cross-origin
  simple-POST can't trigger a state change.
- **Snapshot-bound commit** — `/api/diff` returns a hash of the exact repo state (HEAD + `git status -uall`,
  including untracked files `git add -A` would stage). `/api/commit` requires it and **fails closed with 409**
  if the working tree drifted since review. The committed state is the reviewed state.
- **Per-repository serialization** of the snapshot-check → stage → commit sequence.
- **Rate limits** (`DAN_OSS_COMMIT_RATE_MAX` / `DAN_OSS_COMMIT_WRITE_MAX`) → **429**.
- **Commit-message validation** (non-empty, no control characters, size cap) → **422**; model output is
  control-char-scrubbed.
- **Real HTTP status codes** — 401 / 409 / 415 / 422 / 429 / 5xx; a Git or LLM-provider failure is no longer a
  false `200`.
- **Append-only audit** (`~/.dan-oss-commit/audit.log`) of commits, generate calls, and auth failures.

### Changed — BREAKING
- The `/api/` surface now **requires the token**, and `/api/commit` now **requires the `snapshot`** returned by
  `/api/diff`. Update any 0.1.x caller.

### Notes / honest limits
- A process running as the same OS user can run `git` on the repo directly anyway — it is inside the boundary by
  definition; the token defends the browser/CSRF vector and other OS users. A full per-blob content manifest and
  OS-authenticated IPC are out of scope for this local tier.
- Kept from 0.1.x: loopback bind, DNS-rebind guard, `execFile` (no shell), static path-traversal guard, 40 MiB
  body cap, LLM input truncation.

## [0.1.0]
- Initial release: local AI-assisted commit-message tool — reads your real staged/unstaged diff, generates a
  message via your own OpenAI/Anthropic key, and runs the real `git commit`. Loopback-only, zero dependencies.
