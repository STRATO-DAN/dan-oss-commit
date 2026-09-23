#!/usr/bin/env node
// [DAN] COMMIT — real CLI entry. Starts the local server (loopback only), opens the browser,
// and exits cleanly on Ctrl-C. No global install required — `npx dan-oss-commit` in any real
// git repo.
import { listen } from "../src/server.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Launcher flags (hand-rolled, zero-dependency) ──────────────────────────────────────────────
// Purely additive: with no recognized flag, startup behaves exactly as it did before. `--version`
// and `--help` are pure queries that print and exit 0; `--json` only swaps the human banner for one
// machine-readable line. An unknown option is a usage error (exit 2) rather than a silent no-op.
const argv = process.argv.slice(2);

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  const v = readVersion();
  process.stdout.write(
`dan-oss-commit ${v} — read your real staged git diff and write a real commit message.

Usage:
  dan-oss-commit [options]

Run inside a real git repository. With no options it starts a loopback-only HTTP
server (127.0.0.1), opens your browser at a one-time token-bearing URL, and serves
the dashboard until you press Ctrl-C.

Options:
  --json        Print the startup banner as a single JSON object
                {url, port, mode, dataDir} instead of the human-readable banner.
                (The access token is never printed; it reaches the browser via the opener.)
  --version     Print the version and exit.
  --help, -h    Print this help and exit.

Environment:
  DAN_OSS_COMMIT_PORT           Local port (default 4870).
  DAN_OSS_COMMIT_TOKEN          Fix the instance bearer token (agents/CI).
  DAN_OSS_COMMIT_OPEN           0/false/no/off to skip auto-opening a browser.
  DAN_OSS_COMMIT_OPENER         Override the browser-opener command (headless/CI).
  DAN_OSS_COMMIT_AUDIT          Audit-log file (default ~/.dan-oss-commit/audit.log).
  DAN_OSS_COMMIT_MODEL          Model name passed to the provider API.
  DAN_OSS_COMMIT_MAX_BODY       Max /api/ request-body size in bytes (default 262144).
  DAN_OSS_COMMIT_RATE_MAX       Max authenticated /api/ requests per minute (default 300).
  DAN_OSS_COMMIT_GENERATE_MAX   Max /api/generate requests per minute (default 60, own budget).
  DAN_OSS_COMMIT_COMMIT_MAX     Max /api/commit requests per minute (default 60, own budget).
  DAN_OSS_COMMIT_LLM_TIMEOUT_MS Hard timeout on the external provider call (default 60000).
  DAN_OSS_COMMIT_ALLOW_SECRETS  1/true/yes to downgrade the secret gate to advisory.
  (The Generate button needs a provider API key, e.g. OPENAI_API_KEY, set in your environment.)

Exit codes:
  0  Normal operation (also --help / --version).
  1  Startup failure — e.g. the port is already in use, or the data directory is unusable.
  2  Invalid command-line usage — an unknown option.
`);
}

let jsonMode = false;
for (const arg of argv) {
  if (arg === "--version") {
    process.stdout.write(readVersion() + "\n");
    process.exit(0);
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else if (arg === "--json") {
    jsonMode = true;
  } else {
    process.stderr.write(`dan-oss-commit: unknown option '${arg}'\nTry 'dan-oss-commit --help'.\n`);
    process.exit(2);
  }
}

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_COMMIT_PORT) || 4870;

// The data directory is where the hash-chained audit trail lives (see src/audit.js). It is a real
// security feature, so an unusable data dir is a startup FAILURE (exit 1) — not a silent degradation.
// Checking it here, before we bind, turns "the audit dir isn't writable" into one clear stderr line
// instead of a best-effort warning buried after the server is already listening.
const auditFile = process.env.DAN_OSS_COMMIT_AUDIT || path.join(os.homedir(), ".dan-oss-commit", "audit.log");
const dataDir = path.dirname(auditFile);
try {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (err) {
  process.stderr.write(
    `dan-oss-commit: cannot start — data directory is not usable (${dataDir}): ${err.code || err.message}\n`,
  );
  process.exit(1);
}

// Startup failure must be a one-line stderr message + non-zero exit, never a raw stack. The two most
// likely causes are the port already being in use (EADDRINUSE) and no permission to bind (EACCES);
// anything else still gets a clean single line rather than an unhandled rejection dumping a trace.
let server;
try {
  server = await listen(port, cwd);
} catch (err) {
  if (err && err.code === "EADDRINUSE") {
    process.stderr.write(
      `dan-oss-commit: cannot start — port ${port} is already in use. Set DAN_OSS_COMMIT_PORT to choose another.\n`,
    );
  } else if (err && err.code === "EACCES") {
    process.stderr.write(
      `dan-oss-commit: cannot start — no permission to bind port ${port}. Set DAN_OSS_COMMIT_PORT to choose another.\n`,
    );
  } else {
    process.stderr.write(`dan-oss-commit: cannot start — ${(err && (err.message || err.code)) || err}\n`);
  }
  process.exit(1);
}

// A late server 'error' (after a successful bind) must also die with a one-line message, never a raw
// stack — otherwise it would surface as an uncaught exception with a full trace.
server.on("error", (err) => {
  process.stderr.write(`dan-oss-commit: server error — ${(err && (err.message || err.code)) || err}\n`);
  process.exit(1);
});

const token = server.commitToken;
const base = `http://127.0.0.1:${port}`;
// The dashboard needs the instance token to call the API — it travels in the launch URL, the one channel
// a zero-install local CLI has to hand a just-opened browser. The token is ephemeral (per run, never
// written to disk), so this URL is a one-time credential.
const url = `${base}/?token=${encodeURIComponent(token)}`;

// Auto-open can be disabled (DAN_OSS_COMMIT_OPEN=0) for headless/CI runs; `mode` names which path we're on.
const noOpen = /^(0|false|no|off)$/i.test(String(process.env.DAN_OSS_COMMIT_OPEN || ""));
const mode = noOpen ? "headless" : "browser";

// 🔴 C7 — the token is NOT printed to stdout on the normal path. Terminal scrollback, shell history, and
// captured logs are all real leak surfaces, so stdout carries only the non-secret base address; the token
// reaches the browser through the opener, not the console. Residual, documented exposure: the token still
// rides in the opener's argv (the only channel a browser-open has), briefly visible to other OS users via
// the process list — bounded by the token being ephemeral and gone the moment this process exits.
if (jsonMode) {
  // --json — ONE machine-readable object instead of the human banner. Same C7 reasoning: the token is
  // deliberately absent (stdout is a leak surface); it still reaches the browser via the opener below.
  process.stdout.write(JSON.stringify({ url: base, port, mode, dataDir }) + "\n");
} else {
  console.log(`[DAN] COMMIT running — opening your browser with a one-time access link.`);
  console.log(`Dashboard: ${base}  (your access token is delivered to the browser, not printed here)`);
  console.log(`Reading real changes in: ${cwd}`);
  console.log("Ctrl-C to stop.\n");
}

// Best-effort browser open — never the reason the tool fails to start. Auto-open can be disabled
// (DAN_OSS_COMMIT_OPEN=0) and the opener command overridden (DAN_OSS_COMMIT_OPENER) for headless/CI runs.
if (noOpen) {
  // The user opted out of auto-open, so they need the token-bearing URL to reach the dashboard themselves.
  // In --json mode this goes to stderr so stdout stays exactly one JSON object.
  const msg = `Auto-open disabled. Open this URL yourself (it carries your access token):\n  ${url}`;
  if (jsonMode) process.stderr.write(msg + "\n");
  else console.log(msg);
} else {
  // execFile (no shell); on Windows `start` is a cmd builtin, so it runs via cmd.exe.
  const opener = process.env.DAN_OSS_COMMIT_OPENER;
  const [openerCmd, openerArgs] = opener
    ? [opener, [url]]
    : process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(openerCmd, openerArgs, (err) => {
    if (err) {
      // Only NOW does the token-bearing URL reach the user — as a fallback so a failed auto-open doesn't
      // strand them. The single intentional path where the token is surfaced, and only on failure. In
      // --json mode it goes to stderr so stdout stays exactly one JSON object.
      const msg = `Couldn't open a browser automatically. Open this URL yourself (it carries your token):\n  ${url}`;
      if (jsonMode) process.stderr.write(msg + "\n");
      else console.log(msg);
    }
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
