// Real local HTTP server, stdlib only — zero runtime dependencies is a deliberate choice for a
// one-command install tool (nothing to audit, nothing to go stale, nothing supply-chain-risky
// pulled in just to serve a handful of local routes).
//
// 🔴 LOOPBACK ONLY. Binds to 127.0.0.1, never 0.0.0.0 — this reads the user's own git diff and
// (on /api/generate) sends it to a real third-party LLM API using the user's own key. Nothing
// about that should ever be reachable from another machine on the network.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRepo, realDiff, changedFiles, realCommit, currentBranch, hasCommits } from "./git.js";
import { generateCommitMessage, configuredProvider } from "./llm.js";

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

// 🔴 DNS-rebinding guard. This loopback server reads the user's git diff and can create commits, so it
// must only answer requests whose Host is loopback — a web page the user visits cannot rebind a hostname
// to 127.0.0.1 and reach these APIs. HTTP/1.1 requires a Host header, so a missing one is refused.
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    host = host.slice(1, host.indexOf("]")); // [::1]:port -> ::1
  } else {
    host = host.replace(/:\d+$/, ""); // 127.0.0.1:port / localhost:port -> strip port
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // Real cap — a runaway/malicious client body must not be read into memory unbounded.
      if (size > 40 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
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

async function serveStatic(req, res, urlPath) {
  // Real path-traversal guard: resolve against PUBLIC_DIR and refuse anything that escapes it,
  // rather than trusting the URL's own `..` segments to be well-formed.
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

export function createServer({ cwd = process.cwd() } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    // Refuse any request whose Host isn't loopback (DNS-rebinding guard — see isLoopbackHost).
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
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

      if (url.pathname === "/api/diff" && req.method === "GET") {
        if (!(await isRepo(cwd))) {
          return sendJson(res, 200, { ok: false, reason: `${cwd} is not a real git repository.` });
        }
        const { diff, source } = await realDiff(cwd);
        const files = source === "none" ? [] : await changedFiles(cwd, source);
        return sendJson(res, 200, { ok: true, diff, source, files });
      }

      if (url.pathname === "/api/generate" && req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.diff !== "string") {
          return sendJson(res, 400, { ok: false, reason: "diff (string) is required" });
        }
        try {
          const result = await generateCommitMessage(body.diff);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 200, { ok: false, reason: err.message });
        }
      }

      if (url.pathname === "/api/commit" && req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.message !== "string" || !body.message.trim()) {
          return sendJson(res, 400, { ok: false, reason: "message (non-empty string) is required" });
        }
        try {
          const result = await realCommit(cwd, body.message, { stageAll: body.stageAll === true });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 200, { ok: false, reason: err.message });
        }
      }

      if (req.method === "GET") {
        return serveStatic(req, res, url.pathname);
      }

      res.writeHead(404).end("not found");
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: err.message });
    }
  });
}

export function listen(port, cwd) {
  const server = createServer({ cwd });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
