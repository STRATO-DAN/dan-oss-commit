#!/usr/bin/env node
// [DAN] COMMIT — real CLI entry. Starts the local server (loopback only), opens the browser,
// and exits cleanly on Ctrl-C. No global install required — `npx dan-oss-commit` in any real
// git repo.
import { listen } from "../src/server.js";
import { execFile } from "node:child_process";

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_COMMIT_PORT) || 4870;

const server = await listen(port, cwd);
const url = `http://127.0.0.1:${port}`;

console.log(`[DAN] COMMIT running at ${url}`);
console.log(`Reading real changes in: ${cwd}`);
console.log("Ctrl-C to stop.\n");

// Best-effort browser open — never the reason the tool fails to start. execFile (no shell); on Windows
// `start` is a cmd builtin, so it must run via cmd.exe rather than be exec'd as if it were a binary.
const [openerCmd, openerArgs] =
  process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
execFile(openerCmd, openerArgs, () => {});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
