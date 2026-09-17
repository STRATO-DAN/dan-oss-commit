#!/usr/bin/env bash
# Reproducible, OFFLINE demo for `make demo`. No network, no real API key, no changes to your repo:
# everything happens inside a throwaway git repo under a temp dir that is removed on exit.
#
# It shows the two real halves of the tool end to end:
#   1. reading a REAL staged diff via the library the UI itself calls
#      (examples/read-diff-and-generate.mjs — it exits gracefully with no API key configured), and
#   2. the deny-by-default SECRET GATE: staging a fake, credential-shaped line and running the
#      exported detectSecrets/looksLikeSecret from src/secrets.js on the real diff.
#
# The fake credential is assembled from fragments at run time, so this script's own committed source
# never contains a contiguous secret-shaped literal (same discipline src/secrets.js holds to).
set -eu

ROOT="$(pwd)"                       # repo root — `make` invokes us from here
TMPREPO="$(mktemp -d "${TMPDIR:-/tmp}/dan-oss-commit-demo.XXXXXX")"
cleanup() { rm -rf "$TMPREPO"; }
trap cleanup EXIT

# ── a throwaway repo with one commit ────────────────────────────────────────────────────────────
git -C "$TMPREPO" init -q -b main
git -C "$TMPREPO" config user.email demo@example.com
git -C "$TMPREPO" config user.name Demo
printf 'export function greet(name) {\n  return "Hello, " + name;\n}\n' > "$TMPREPO/greet.js"
git -C "$TMPREPO" add -A
git -C "$TMPREPO" commit -q -m "Add greet function"

echo "=============================================================================="
echo " make demo — part 1: read the REAL staged diff (no API key configured)"
echo "=============================================================================="
# a real change, staged
printf 'export function greet(name) {\n  if (!name) return "Hello there";\n  return "Hello, " + name + "!";\n}\n' > "$TMPREPO/greet.js"
git -C "$TMPREPO" add -A
# Run the same library the UI calls, in a SCRUBBED environment (env -i) so no provider API key can be
# present — the example then prints the real diff and exits gracefully instead of calling any provider.
# Only PATH and HOME are re-added, the minimum node + git need.
env -i PATH="$PATH" HOME="$HOME" "${NODE:-node}" "$ROOT/examples/read-diff-and-generate.mjs" "$TMPREPO"

echo ""
echo "=============================================================================="
echo " make demo — part 2: the deny-by-default SECRET GATE"
echo "=============================================================================="
# Assemble a fake, AWS-access-key-shaped value from fragments (never a contiguous literal in source).
AWS_PREFIX=AKIA
FAKE_AWS_KEY="${AWS_PREFIX}IOSFODNN7EXAMPLE"
printf 'const AWS_ACCESS_KEY_ID = "%s";\n' "$FAKE_AWS_KEY" >> "$TMPREPO/greet.js"
git -C "$TMPREPO" add -A
git -C "$TMPREPO" diff --staged > "$TMPREPO/staged.diff"
echo "Staged a fake AWS-access-key-shaped line; scanning the real diff with src/secrets.js ..."
echo ""
# Call the EXPORTED detectSecrets/looksLikeSecret on the real staged diff. --eval imports resolve
# relative to cwd (the repo root), so './src/secrets.js' is this package's own scanner.
"${NODE:-node}" --input-type=module -e '
import { detectSecrets, looksLikeSecret } from "./src/secrets.js";
import fs from "node:fs";
const diff = fs.readFileSync(process.argv[1], "utf8");
const patterns = detectSecrets(diff);
console.log("looksLikeSecret(diff) :", looksLikeSecret(diff));
console.log("detectSecrets(diff)   :", JSON.stringify(patterns));
if (patterns.includes("aws-access-key-id")) {
  console.log("");
  console.log("GATE: an AWS access key id was detected in the diff.");
  console.log("      /api/generate would return 422 (secretBlocked) and make NO provider call.");
  process.exit(0);
}
console.error("UNEXPECTED: the secret gate did not flag the staged credential.");
process.exit(1);
' "$TMPREPO/staged.diff"

echo ""
echo "demo complete — throwaway repo removed."
