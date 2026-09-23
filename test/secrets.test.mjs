// Unit tests for the zero-dependency secret scanner. Every fake credential below is assembled from
// string fragments, so this test file itself never contains a contiguous literal that a secret scanner
// (or this repo's own pre-commit guard) would flag as real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSecrets, looksLikeSecret } from "../src/secrets.js";

// ── each supported shape is detected, and reported by its type NAME (never the value) ──────────────
const CASES = [
  ["aws-access-key-id", "AKIA" + "ABCDEFGHIJKLMNOP"],
  ["private-key-block", "-----BEGIN " + "RSA " + "PRIVATE KEY-----"],
  ["private-key-block", "-----BEGIN " + "OPENSSH " + "PRIVATE KEY-----"],
  ["private-key-block", "-----BEGIN " + "PRIVATE KEY-----"], // no algorithm prefix
  ["openai-api-key", "sk-" + "abcdefghij0123456789XY"],
  ["stripe-secret-key", "sk_live_" + "abcdef0123456789"],
  ["stripe-restricted-key", "rk_live_" + "abcdef0123456789"],
  ["github-token", "ghp_" + "A".repeat(36)],
  ["github-token", "ghs_" + "b".repeat(40)],
  ["github-fine-grained-pat", "github_pat_" + "A".repeat(42)],
  ["google-api-key", "AIza" + "a".repeat(35)],
  ["slack-token", "xoxb-" + "0123456789abcd"],
  ["jwt", "eyJ" + "abcdefghij" + "." + "klmnopqrst" + "." + "uvwxyz0123"],
  ["generic-secret-assignment", 'password = "' + "hunter2xxx" + '"'],
  ["generic-secret-assignment", "api_key: '" + "s3cr3tv4lue" + "'"],
  // REAL FIX (external review, 2026-09-23): the real, common shape (all-caps env-style with
  // "_ACCESS_KEY" between "SECRET" and the assignment) previously never matched at all -- no
  // separator was allowed between "aws_secret" and the value.
  ["aws-secret-key", "AWS_SECRET_ACCESS_KEY=" + "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"],
  ["aws-secret-key", "aws_secret_key: " + "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"],
  // REAL ADDITIONS (external review, 2026-09-23): three real provider shapes previously missed.
  ["sendgrid-api-key", "SG." + "a".repeat(22) + "." + "b".repeat(43)],
  ["huggingface-token", "hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYz".repeat(1)],
  ["azure-storage-account-key", "AccountKey=" + "a".repeat(60) + "=="],
];

for (const [name, sample] of CASES) {
  test(`detectSecrets flags ${name}`, () => {
    const diff = `diff --git a/f b/f\n+${sample}\n`;
    const found = detectSecrets(diff);
    assert.ok(found.includes(name), `expected ${name} to be detected in ${found.join(",") || "(none)"}`);
    // The report is a list of type NAMES only — it must never carry the secret value back to the caller.
    assert.ok(!JSON.stringify(found).includes(sample), "the matched value must never appear in the result");
  });
}

// ── ordinary code and near-misses are NOT flagged ──────────────────────────────────────────────────
test("detectSecrets leaves ordinary diffs alone", () => {
  assert.deepEqual(detectSecrets("+const total = subtotal + tax;"), []);
  assert.deepEqual(detectSecrets("+function add(a, b) { return a + b; }"), []);
});

test("detectSecrets does not flag prefixes that are too short to be a credential", () => {
  assert.deepEqual(detectSecrets("+let x = 'sk-short';"), []); // sk- but < 20 chars
  assert.deepEqual(detectSecrets("+// AKIA is a prefix"), []); // AKIA but not followed by 16 key chars
  assert.deepEqual(detectSecrets("+password = 'short'"), []); // quoted value < 8 chars
});

// REAL FALSE-POSITIVE FIX (external review, 2026-09-23): the exact case the review flagged --
// this is a property access expression (a real value the variable already holds), never a
// literal secret. The unquoted-assignment pattern's value class used to allow `.`, which made
// this match; fixed by removing `.` from that class.
test("detectSecrets does not flag ordinary property-access code as a secret", () => {
  assert.deepEqual(detectSecrets("+password = user.passwordHash;"), []);
  assert.deepEqual(detectSecrets("+const token = req.session.token;"), []);
});

test("detectSecrets reports every distinct type present, deduped", () => {
  const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
  const oai = "sk-" + "abcdefghij0123456789XY";
  const found = detectSecrets(`+a = ${aws}\n+b = ${oai}\n+c = ${aws}\n`);
  assert.ok(found.includes("aws-access-key-id"));
  assert.ok(found.includes("openai-api-key"));
  // Deduped: aws appears twice in the input but once in the result.
  assert.equal(found.filter((n) => n === "aws-access-key-id").length, 1);
});

test("detectSecrets handles non-string / empty input safely", () => {
  assert.deepEqual(detectSecrets(""), []);
  assert.deepEqual(detectSecrets(null), []);
  assert.deepEqual(detectSecrets(undefined), []);
});

test("looksLikeSecret is the boolean form of detectSecrets", () => {
  assert.equal(looksLikeSecret("AKIA" + "ABCDEFGHIJKLMNOP"), true);
  assert.equal(looksLikeSecret("+const n = 1;"), false);
});

// ── linear-time guarantee: a long adversarial near-match must not blow up (no ReDoS) ────────────────
test("detectSecrets runs in linear time on a long adversarial near-match (no catastrophic backtracking)", () => {
  // A value that starts the generic-assignment pattern then runs 200k chars with no closing quote —
  // the classic shape that makes a backtracking-prone regex hang. A linear pattern finishes instantly.
  const evil = 'password = "' + "x".repeat(200000);
  const start = Date.now();
  const found = detectSecrets(evil);
  const elapsed = Date.now() - start;
  assert.deepEqual(found, [], "an unterminated quoted value is not a match");
  assert.ok(elapsed < 1000, `scan must be linear (took ${elapsed}ms — a ReDoS would take far longer)`);
});
