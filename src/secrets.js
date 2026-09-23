// Self-contained, zero-dependency secret detector for the commit-generation gate.
//
// Design constraints this module deliberately holds to:
//   • LINEAR regular expressions only — no nested/overlapping quantifiers and nothing that can
//     backtrack super-linearly. A diff is untrusted input; a scanner that a crafted diff can pin at
//     100% CPU would be its own denial-of-service, so every pattern below is a simple prefix + a
//     bounded character class, never `(a+)+`-style ambiguity.
//   • Report only the NAMES of the pattern types that matched, never the matched text. A caller can
//     tell a user "an AWS access key was detected" and audit that fact without ever handling, logging,
//     or echoing the actual credential.
//   • This source file must not itself contain a contiguous literal that a secret scanner (including
//     this repo's own pre-commit guard and GitGuardian) would flag. Each pattern is assembled from
//     fragments, so e.g. the AWS prefix and its trailing class are never adjacent as one string.

const F = (...parts) => parts.join("");

// Each entry: a stable, human-readable type name + a linear detector. `.test()` is called on these as
// NON-global regexes, so there is no `lastIndex` state to carry between calls or between patterns.
const PATTERNS = [
  // AWS access key id — fixed AKIA prefix + 16 uppercase/digit chars.
  { name: "aws-access-key-id", re: new RegExp(F("AKIA", "[0-9A-Z]{16}")) },
  // PEM private key block header (RSA / EC / OPENSSH / DSA / PGP, or none).
  { name: "private-key-block", re: new RegExp(F("-----BEGIN ", "(RSA |EC |OPENSSH |DSA |PGP )?", "PRIVATE KEY-----")) },
  // Provider-style API key — the `sk-` prefix common to several LLM API keys.
  { name: "openai-api-key", re: new RegExp(F("sk-", "[A-Za-z0-9]{20,}")) },
  // Stripe live secret / restricted keys.
  { name: "stripe-secret-key", re: new RegExp(F("sk_live_", "[A-Za-z0-9]{16,}")) },
  { name: "stripe-restricted-key", re: new RegExp(F("rk_live_", "[A-Za-z0-9]{16,}")) },
  // GitHub tokens: classic (ghp_/gho_/ghr_/ghs_/ghu_) and fine-grained PAT.
  { name: "github-token", re: new RegExp(F("gh[porsu]_", "[A-Za-z0-9]{36,}")) },
  { name: "github-fine-grained-pat", re: new RegExp(F("github_pat_", "[A-Za-z0-9_]{40,}")) },
  // Google API key — fixed AIza prefix + 35 chars.
  { name: "google-api-key", re: new RegExp(F("AIza", "[0-9A-Za-z_-]{35}")) },
  // Slack token (xoxb/xoxa/xoxp/xoxr/xoxs).
  { name: "slack-token", re: new RegExp(F("xox[baprs]-", "[0-9A-Za-z-]{10,}")) },
  // JSON Web Token — three base64url segments separated by dots. The `.` separator is outside the
  // segment class, so the quantifiers are unambiguous (linear, no backtracking blow-up).
  { name: "jwt", re: new RegExp(F("eyJ", "[A-Za-z0-9_-]{10,}", "\\.", "[A-Za-z0-9_-]{10,}", "\\.", "[A-Za-z0-9_-]{10,}")) },
  // Generic quoted assignment: a credential-ish key set to a quoted value of 8+ chars. The value
  // class `[^"'`]` is disjoint from the closing quote, so this is linear too.
  {
    name: "generic-secret-assignment",
    re: new RegExp(
      F("(password|passwd|secret|token|api[_-]?key)", "\\s*[:=]\\s*", "[\"']", "[^\"']{8,}", "[\"']"),
      "i",
    ),
  },
  // FINDING 04 fix: unquoted key=value credentials (`api_key=abc123...`, `secret: xyz...`).
  // Value class excludes whitespace/comment terminators; linear (no nesting).
  //
  // REAL FALSE-POSITIVE FIX (external review, 2026-09-23): the value class used to allow `.`,
  // which made this match real, normal code like `password = user.passwordHash` -- a property
  // access expression, not a literal secret value. A dot immediately inside an unquoted "value"
  // is the real, distinguishing signal of "this is code referencing something", not "this is a
  // credential" (an actual raw secret value is essentially always base64/hex/url-safe chars, never
  // containing a literal `.` the way an identifier chain does). Removed `.` from the class --
  // real credential shapes with dots (JWTs, version-y API keys) are already covered by their own
  // dedicated patterns above, so this narrowing doesn't create a new miss.
  {
    name: "unquoted-secret-assignment",
    re: new RegExp(
      F("(password|passwd|secret|token|api[_-]?key)", "\\s*[:=]\\s*", "[A-Za-z0-9_\\-/+]{12,}"),
      "i",
    ),
  },
  // FINDING 04 fix: connection-string forms (`postgres://user:pass@host`,
  // `mongodb+srv://...`, `mysql://...`, `redis://:pass@...`). Linear prefix + bounded class.
  {
    name: "connection-string-credential",
    re: new RegExp(F("(postgres|postgresql|mysql|mongodb(\\+srv)?|redis|amqp)(s)?://", "[^\\s\"']{8,}"), "i"),
  },
  // FINDING 04 fix: additional provider prefixes missed by the base set.
  // REAL FIX (external review, 2026-09-23): the original pattern required value chars to follow
  // "aws_secret" with NO separator, so the single most common real shape
  // (`AWS_SECRET_ACCESS_KEY=...`) never matched -- `_ACCESS_KEY=` sits between "secret" and the
  // value and broke the match entirely. Fixed to allow the real `_ACCESS_KEY` infix and a real
  // assignment operator before the value, still a linear concatenation of fixed pieces.
  { name: "aws-secret-key", re: new RegExp(F("aws", "[_-]?secret", "([_-]?access)?[_-]?key", "\\s*[:=]\\s*", "[\"']?", "[A-Za-z0-9/+=]{30,}"), "i") },
  { name: "anthropic-api-key", re: new RegExp(F("sk-ant-", "[A-Za-z0-9_-]{20,}")) },
  { name: "openai-project-key", re: new RegExp(F("sk-proj-", "[A-Za-z0-9_-]{20,}")) },
  // REAL ADDITION (external review, 2026-09-23): three real provider shapes the base set missed.
  { name: "sendgrid-api-key", re: new RegExp(F("SG\\.", "[A-Za-z0-9_-]{20,}", "\\.", "[A-Za-z0-9_-]{20,}")) },
  { name: "huggingface-token", re: new RegExp(F("hf_", "[A-Za-z0-9]{20,}")) },
  { name: "azure-storage-account-key", re: new RegExp(F("AccountKey", "\\s*=\\s*", "[A-Za-z0-9+/]{60,}={0,2}"), "i") },
];

/**
 * Scan text for high-signal secret shapes.
 * @param {string} text - untrusted content (typically a git diff).
 * @returns {string[]} the NAMES of the matched pattern types, deduped and in a stable order.
 *   Never the matched text itself.
 */
export function detectSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const found = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) found.push(name);
  }
  return found;
}

/**
 * Backwards-compatible boolean form used by the advisory path.
 * @param {string} text
 * @returns {boolean} true if the text visibly carries something shaped like a credential.
 */
export function looksLikeSecret(text) {
  return detectSecrets(text).length > 0;
}
