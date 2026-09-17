#!/usr/bin/env node
// [DAN] COMMIT — real CLI entry. Starts the local server (loopback only), opens the browser,
// and exits cleanly on Ctrl-C. No global install required — `npx dan-oss-commit` in any real
// git repo.
import { listen } from "../src/server.js";
import { execFile } from "node:child_process";

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_COMMIT_PORT) || 4870;

const server = await listen(port, cwd);
const token = server.commitToken;
const base = `http://127.0.0.1:${port}`;
// The dashboard needs the instance token to call the API — it travels in the launch URL, the one channel
// a zero-install local CLI has to hand a just-opened browser. The token is ephemeral (per run, never
// written to disk), so this URL is a one-time credential.
const url = `${base}/?token=${encodeURIComponent(token)}`;

// 🔴 C7 — the token is NOT printed to stdout on the normal path. Terminal scrollback, shell history, and
// captured logs are all real leak surfaces, so stdout carries only the non-secret base address; the token
// reaches the browser through the opener, not the console. Residual, documented exposure: the token still
// rides in the opener's argv (the only channel a browser-open has), briefly visible to other OS users via
// the process list — bounded by the token being ephemeral and gone the moment this process exits.
console.log(`[DAN] COMMIT running — opening your browser with a one-time access link.`);
console.log(`Dashboard: ${base}  (your access token is delivered to the browser, not printed here)`);
console.log(`Reading real changes in: ${cwd}`);
console.log("Ctrl-C to stop.\n");

// Best-effort browser open — never the reason the tool fails to start. Auto-open can be disabled
// (DAN_OSS_COMMIT_OPEN=0) and the opener command overridden (DAN_OSS_COMMIT_OPENER) for headless/CI runs.
const noOpen = /^(0|false|no|off)$/i.test(String(process.env.DAN_OSS_COMMIT_OPEN || ""));
if (noOpen) {
  // The user opted out of auto-open, so they need the token-bearing URL to reach the dashboard themselves.
  console.log(`Auto-open disabled. Open this URL yourself (it carries your access token):\n  ${url}`);
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
      // Only NOW does the token-bearing URL reach stdout — as a fallback so a failed auto-open doesn't
      // strand the user. The single intentional path where the token is printed, and only on failure.
      console.log(`Couldn't open a browser automatically. Open this URL yourself (it carries your token):\n  ${url}`);
    }
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
