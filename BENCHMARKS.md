# Benchmarks

## Secret-scan throughput

`src/secrets.js` sits on the diff→LLM boundary and scans an **untrusted** git diff before anything
leaves the machine. Every pattern in it is a **linear** regular expression — no nested or overlapping
quantifiers — so a crafted diff cannot pin it at 100% CPU (a ReDoS would be its own denial of service).
This benchmark makes that property measurable: it runs the exported `detectSecrets` over synthetic
diffs of increasing size and reports throughput. Roughly constant MB/s as the input grows is the
signature of linear-time scanning.

Real numbers from `make bench`:

```
==============================================================================
 make bench — secret-scan throughput (detectSecrets, src/secrets.js)
==============================================================================
node v22.23.1 on Darwin 25.6.0 (arm64)

  size(MB)   passes   per-pass(ms)      MB/s
  --------   ------   ------------   -------
      0.25     2000         0.3486     717.3
      0.50     1263         0.6338     789.0
      1.00      628         1.2751     784.4

Roughly constant MB/s across sizes ⇒ linear-time, ReDoS-safe scanning.
```

Per-pass time grows in step with input size (≈0.35 ms → ≈0.64 ms → ≈1.28 ms as the diff doubles then
doubles again) while MB/s stays in the same ~720–790 MB/s band — i.e. **O(n)**, not super-linear.

**Reproduce:** `make bench`

**Machine:** Node v22.23.1, Darwin 25.6.0 (macOS, arm64). Numbers are hardware-dependent; the shape
(constant MB/s across sizes) is what matters, not the absolute figure. The benchmark is stdlib-only,
makes no network calls, needs no API key, and finishes in well under 15 seconds.
