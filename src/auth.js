// [DAN] COMMIT — local caller authentication (v0.2). This tool exposes a privileged Git-mutation and an
// external-LLM control plane over loopback. Loopback + the DNS-rebind guard say WHERE a request came from;
// they do NOT say the caller is the intended UI/process. So every /api/ op requires the instance bearer
// token. The token is EPHEMERAL — generated per process, never written to disk (writing it into the repo's
// own working tree could get committed by this very tool), handed to the dashboard in the launch URL, and
// overridable with DAN_OSS_COMMIT_TOKEN for agents/CI.
//
// Honest limit: a process running as the same OS user can run `git` on the repo directly anyway, so it is
// inside the boundary by definition; the token defends the browser/CSRF vector and other OS users.
import crypto from "node:crypto";

/** The instance token: DAN_OSS_COMMIT_TOKEN if set, else a fresh 256-bit per-process token. */
export function makeToken() {
  const env = (process.env.DAN_OSS_COMMIT_TOKEN || "").trim();
  return env || crypto.randomBytes(32).toString("base64url");
}

/** Constant-time bearer check. Parses the Authorization header by fixed prefix, NOT a regex: the header is
 *  attacker-controlled and reached BEFORE auth passes, so a backtracking pattern (e.g. /^Bearer\s+(.+)$/,
 *  where \s and . both match a space) would be a ReDoS an unauthenticated caller could trip. Prefix slice
 *  + trim is strictly linear. */
export function bearerOk(req, token) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return false;
  const PREFIX = "bearer ";
  if (header.length < PREFIX.length || header.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    return false;
  }
  const got = Buffer.from(header.slice(PREFIX.length).trim());
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
