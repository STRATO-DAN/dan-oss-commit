// Real local HTTP server, stdlib only — zero runtime dependencies for a one-command install tool.
//
// 🔴 v0.2 SECURITY MODEL. This surface is a privileged Git-mutation + external-LLM control plane, so
// locality is NOT the trust decision: every /api/ op requires the instance bearer token (auth.js), POSTs
// must be application/json (a text/plain cross-origin simple-POST is refused), calls are rate-limited, a
// commit is BOUND to the exact repository snapshot the user reviewed (fail-closed 409 on drift), repository
// mutations are serialized, and commits/generate/auth-failures are audited. Loopback bind + DNS-rebind guard
// remain as belt-and-suspenders.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRepo,
  realDiff,
  changedFiles,
  currentBranch,
  hasCommits,
  repoTrees,
  snapshotOfTrees,
  commitTree,
} from "./git.js";
import { generateCommitMessage, configuredProvider } from "./llm.js";
import { makeToken, bearerOk } from "./auth.js";
import { makeAudit } from "./audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Characters that must never enter a commit message or a model result:
//  • C0 controls + DEL — except tab / LF / CR, which real multi-line messages legitimately use.
//  • Unicode line/paragraph separators and NEL (U+0085, U+2028, U+2029) — alternate "newlines" that
//    slip past a plain \n check and can split a stored log line or the commit message unexpectedly.
//  • Bidirectional overrides + isolates (U+202A–202E, U+2066–2069) — the Trojan-Source class: text
//    that renders in a different visual order than it is stored, hiding what a message actually says.
//  • Zero-width space (U+200B) — an invisible character with no legitimate place in a commit summary.
const FORBIDDEN_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0085\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const FORBIDDEN_CHARS_G = new RegExp(FORBIDDEN_CHARS.source, "gu");
const MAX_MESSAGE_CHARS = 20000;

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    host = host.slice(1, host.indexOf("]"));
  } else {
    host = host.replace(/:\d+$/, "");
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// 🔴 C4 — the request body is read fully into memory before the LLM path truncates it (60,000 chars).
// The old 40 MiB ceiling meant an authenticated caller could make the process buffer 40 MiB per request
// for a payload the model would never see past ~60 KB. The cap is now a modest default (256 KiB — well
// above a JSON-escaped 60 KB diff plus the snapshot/message envelope) and configurable for the rare repo
// whose legitimate diff is larger. Note: shrinking the ceiling bounds memory cost; it is NOT a policy on
// what a diff may contain (the classification/secret-gate on diff→LLM is a product decision, not shipped).
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

function readBody(req) {
  const maxBytes = Number(process.env.DAN_OSS_COMMIT_MAX_BODY) || DEFAULT_MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (c) => {
      if (overflowed) return;
      size += c.length;
      if (size > maxBytes) {
        // Stop buffering and stop reading, but leave the socket up so the handler's error path can send
        // a clean JSON response rather than racing a torn-down connection.
        overflowed = true;
        req.pause();
        reject(new Error(`request body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflowed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function makeRateLimiter({ windowMs, max }) {
  let windowStart = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}

// Per-repository serialization: one server serves one cwd, so a single promise-chained mutex makes the
// snapshot-check + stage + commit sequence atomic against a second concurrent commit request.
function makeMutex() {
  let last = Promise.resolve();
  return (fn) => {
    const result = last.then(() => fn());
    last = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

function validateMessage(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "message (non-empty string) is required";
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return `message too long (max ${MAX_MESSAGE_CHARS} characters)`;
  }
  if (FORBIDDEN_CHARS.test(message)) {
    return "message contains control or bidirectional/invisible characters";
  }
  return null; // ok
}

export function createServer({ cwd = process.cwd(), token = makeToken() } = {}) {
  const audit = makeAudit();
  const apiLimit = makeRateLimiter({ windowMs: 60_000, max: Number(process.env.DAN_OSS_COMMIT_RATE_MAX) || 300 });
  const writeLimit = makeRateLimiter({ windowMs: 60_000, max: Number(process.env.DAN_OSS_COMMIT_WRITE_MAX) || 60 });
  const commitMutex = makeMutex();
  // FINDING 09 fix: bound admission is not enough — concurrent generate/commit paths hold
  // git children + LLM sockets. Cap in-flight LLM generations fail-closed (503) so total
  // resource consumption is bounded, not just request rate.
  const MAX_INFLIGHT_GENERATE = Number(process.env.DAN_OSS_COMMIT_MAX_INFLIGHT_GENERATE) || 2;
  let inflightGenerate = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const p = url.pathname;
    const isApi = p.startsWith("/api/");

    try {
      if (isApi) {
        // 🔴 C3 — RATE LIMIT BEFORE AUTH. The rate check runs ahead of the bearer check so the
        // unauthenticated 401 path (which writes an auth-failure audit line) is itself throttled — an
        // unauthenticated flood can no longer drive unbounded audit writes / disk churn by never
        // presenting a valid token. A throttled request never reaches the audit write below.
        if (!apiLimit()) {
          return sendJson(res, 429, { ok: false, reason: "rate limit exceeded — slow down" });
        }
        // 🔴 AUTH — locality is not identity. Every /api/ op needs the instance bearer token.
        if (!bearerOk(req, token)) {
          audit({ action: "auth-failure", path: p, method: req.method });
          return sendJson(res, 401, { ok: false, reason: "unauthorized — missing or invalid bearer token" });
        }
        // POSTs must be application/json — refuses a text/plain cross-origin simple-POST outright.
        if (req.method === "POST") {
          const ct = String(req.headers["content-type"] || "").toLowerCase();
          if (!ct.includes("application/json")) {
            return sendJson(res, 415, { ok: false, reason: "Content-Type must be application/json" });
          }
        }
      }

      if (p === "/api/status" && req.method === "GET") {
        const repo = await isRepo(cwd);
        return sendJson(res, 200, {
          ok: true,
          isRepo: repo,
          cwd,
          branch: repo ? await currentBranch(cwd) : null,
          hasCommits: repo ? await hasCommits(cwd) : false,
          provider: configuredProvider(),
        });
      }

      if (p === "/api/diff" && req.method === "GET") {
        // 🔴 C9 — capture the reviewed diff, the file list, and the snapshot that BINDS them inside the
        // same critical section as a commit. Running under the shared commit mutex means a commit on this
        // server can't land between reading the diff and reading the snapshot, so the snapshot the caller
        // is handed always describes the same repository state as the diff it just reviewed. The snapshot
        // is derived from the very repoTrees capture the file list is taken alongside — one consistent read.
        const result = await commitMutex(async () => {
          if (!(await isRepo(cwd))) {
            return { status: 200, body: { ok: false, reason: `${cwd} is not a real git repository.` } };
          }
          const { diff, source } = await realDiff(cwd);
          const files = source === "none" ? [] : await changedFiles(cwd, source);
          const snapshot = snapshotOfTrees(await repoTrees(cwd));
          return { status: 200, body: { ok: true, diff, source, files, snapshot } };
        });
        return sendJson(res, result.status, result.body);
      }

      if (p === "/api/generate" && req.method === "POST") {
        if (!writeLimit()) {
          return sendJson(res, 429, { ok: false, reason: "generate rate limit exceeded — slow down" });
        }
        if (inflightGenerate >= MAX_INFLIGHT_GENERATE) {
          return sendJson(res, 503, { ok: false, reason: "server busy — too many concurrent generations" });
        }
        const body = await readBody(req);
        if (typeof body.diff !== "string") {
          return sendJson(res, 400, { ok: false, reason: "diff (string) is required" });
        }
        inflightGenerate += 1;
        try {
          const result = await generateCommitMessage(body.diff);
          const message = String(result.message).replace(FORBIDDEN_CHARS_G, "");
          // FINDING 08 fix: forensic context — repo + branch, never secret content.
          const auditOk = audit({ action: "generate", provider: result.provider, truncated: !!result.truncated, cwd, branch: await currentBranch(cwd).catch(() => null) });
          // The audit write never blocks or fails this response (a broken trail is not a broken
          // feature) — but the caller can now SEE that it happened, instead of the failure being
          // visible only in this process's own stderr.
          return sendJson(res, 200, { ok: true, ...result, message, auditOk });
        } catch (err) {
          // 🔒 Secret gate — a detected credential is a deliberate, client-actionable block (deny by
          // default), NOT an upstream failure: 422, and no LLM call was made. The reason and audit line
          // name only the matched pattern TYPES (err.patterns), never the secret value.
          if (err.secretBlocked) {
            audit({ action: "generate-blocked", reason: "secret-detected", patterns: err.patterns });
            return sendJson(res, 422, {
              ok: false,
              secretBlocked: true,
              patterns: err.patterns,
              reason: err.message,
            });
          }
          // A provider/LLM-boundary failure is an upstream error, not a client success — 502, never a false 2xx.
          // Audited too: the audit trail must record what actually happened, not just successes.
          audit({ action: "generate-failed", reason: err.message, cwd });
          return sendJson(res, 502, { ok: false, reason: err.message });
        } finally {
          inflightGenerate -= 1;
        }
      }

      if (p === "/api/commit" && req.method === "POST") {
        if (!writeLimit()) {
          return sendJson(res, 429, { ok: false, reason: "commit rate limit exceeded — slow down" });
        }
        const body = await readBody(req);
        const badMessage = validateMessage(body.message);
        if (badMessage) {
          return sendJson(res, 422, { ok: false, reason: badMessage });
        }
        if (typeof body.snapshot !== "string" || !body.snapshot) {
          return sendJson(res, 400, { ok: false, reason: "snapshot (from /api/diff) is required" });
        }
        // Serialize inside the lock; capture the reviewed TREE once, verify the content-addressed
        // snapshot against it, then commit THAT EXACT tree. Because the commit is built from the
        // captured tree (not a fresh working-tree re-read), verify and commit can never bind different
        // bytes — closing both the content-drift bypass and the verify→commit TOCTOU.
        const result = await commitMutex(async () => {
          if (!(await isRepo(cwd))) {
            return { status: 400, body: { ok: false, reason: `${cwd} is not a real git repository.` } };
          }
          const trees = await repoTrees(cwd);
          if (snapshotOfTrees(trees) !== body.snapshot) {
            audit({ action: "commit-rejected", reason: "stale-snapshot", cwd, branch: await currentBranch(cwd).catch(() => null) });
            return {
              status: 409,
              body: {
                ok: false,
                stale: true,
                reason: "the repository changed since you reviewed it — reload the diff and review again before committing",
              },
            };
          }
          try {
            const stageAll = body.stageAll === true;
            const tree = stageAll ? trees.workTree : trees.stagedTree;
            const committed = await commitTree(cwd, tree, trees.head, body.message);
            // 🔴 C1 — once commitTree returns, the commit is DURABLE on HEAD even if the index/worktree
            // resync failed (committed.indexResynced === false). Audit the REAL sha either way, tagging a
            // resync failure as `commit-partial` so the trail reflects that HEAD moved — never a silent
            // gap that implies nothing happened. `auditOk` still only reports whether THIS line was written.
            const auditOk = audit({
              action: committed.indexResynced ? "commit" : "commit-partial",
              sha: committed.sha,
              stageAll,
              indexResynced: committed.indexResynced,
              // FINDING 08 fix: bind the forensic record to the exact tree context the user
              // authorized — repo, branch, tree sha, snapshot, head, file count. Message text
              // itself is stored in git; the audit keeps its length + a hash, never the content.
              cwd,
              branch: await currentBranch(cwd).catch(() => null),
              tree,
              head: trees.head,
              snapshot: body.snapshot,
              fileCount: Array.isArray(body.files) ? body.files.length : undefined,
            });
            // The commit landed, so this is a 200 with the real sha (plus C2's hooksBypassed/signed flags
            // and, on a resync failure, a warning) — not a bare 500 implying the commit was lost.
            return { status: 200, body: { ok: true, ...committed, auditOk } };
          } catch (err) {
            // A genuine pre-HEAD-move failure (nothing to commit, or the HEAD-drift CAS aborted): nothing
            // landed on the branch. Audit it truthfully too, then surface a real error status.
            audit({ action: "commit-failed", reason: err.message, cwd });
            return { status: 500, body: { ok: false, reason: err.message } };
          }
        });
        return sendJson(res, result.status, result.body);
      }

      if (req.method === "GET" && !isApi) {
        return serveStatic(res, p);
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: err.message });
    }
  });

  server.commitToken = token; // the CLI prints it; tests read it to authenticate
  return server;
}

export function listen(port, cwd) {
  const server = createServer({ cwd });
  return new Promise((resolve, reject) => {
    // Surface a bind failure (EADDRINUSE, EACCES, …) as a rejected promise so the launcher can exit
    // with a clean one-line message instead of the 'error' event crashing as an uncaught exception.
    // The listener is one-shot and removed on success, so a later runtime error still reaches whatever
    // 'error' handler the caller attaches to the returned server.
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}
