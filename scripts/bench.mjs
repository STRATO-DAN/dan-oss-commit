// Secret-scan throughput benchmark for `make bench`. Stdlib only, no network, no API key.
//
// It runs the exported detectSecrets (src/secrets.js) over a large (~1 MB) synthetic diff and reports
// elapsed ms + MB/s. Because every pattern in the scanner is a LINEAR regex (no nested/overlapping
// quantifiers), throughput stays roughly constant as the input grows — the property that makes the
// scanner ReDoS-safe on an adversarial diff. To make that visible it scans three sizes and prints the
// per-size MB/s, which should stay in the same ballpark rather than collapsing as size grows.
import { detectSecrets } from "../src/secrets.js";
import os from "node:os";

// Build ~`mb` megabytes of realistic, benign diff text (added/context lines). No real secret shapes —
// we are measuring the cost of scanning, and the no-match path runs every pattern to completion.
function makeDiff(mb) {
  const target = Math.round(mb * 1024 * 1024);
  const block =
    "diff --git a/src/module.js b/src/module.js\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/src/module.js\n" +
    "+++ b/src/module.js\n" +
    "@@ -1,6 +1,8 @@\n" +
    "+export function handleRequest(req, res, next) {\n" +
    "+  const parsed = parseIncomingPayload(req.body || {});\n" +
    "+  if (!parsed.ok) return res.status(400).json({ error: parsed.reason });\n" +
    "   const items = parsed.value.filter((entry) => entry.enabled);\n" +
    "   return res.json({ count: items.length, items });\n" +
    " }\n";
  const parts = [];
  let size = 0;
  while (size < target) {
    parts.push(block);
    size += block.length;
  }
  return parts.join("");
}

// Time detectSecrets over `text` for enough passes to get a stable reading (time-boxed, so a slow
// machine never runs long): stop at ~0.8s or 2000 passes, whichever comes first.
function measure(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  const mb = bytes / (1024 * 1024);
  // warm up (JIT) without counting it
  for (let i = 0; i < 3; i++) detectSecrets(text);
  let passes = 0;
  const start = performance.now();
  let elapsed = 0;
  while (passes < 2000) {
    detectSecrets(text);
    passes += 1;
    elapsed = performance.now() - start;
    if (elapsed >= 800) break;
  }
  const perPassMs = elapsed / passes;
  const mbPerSec = (mb * passes) / (elapsed / 1000);
  return { mb, passes, perPassMs, mbPerSec };
}

console.log("==============================================================================");
console.log(" make bench — secret-scan throughput (detectSecrets, src/secrets.js)");
console.log("==============================================================================");
console.log(`node ${process.version} on ${os.type()} ${os.release()} (${os.arch()})`);
console.log("");
console.log("  size(MB)   passes   per-pass(ms)      MB/s");
console.log("  --------   ------   ------------   -------");

for (const mb of [0.25, 0.5, 1.0]) {
  const r = measure(makeDiff(mb));
  console.log(
    "  " +
      r.mb.toFixed(2).padStart(8) +
      "   " +
      String(r.passes).padStart(6) +
      "   " +
      r.perPassMs.toFixed(4).padStart(12) +
      "   " +
      r.mbPerSec.toFixed(1).padStart(7),
  );
}

console.log("");
console.log("Roughly constant MB/s across sizes ⇒ linear-time, ReDoS-safe scanning.");
