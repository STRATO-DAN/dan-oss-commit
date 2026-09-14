// [DAN] COMMIT — real client logic. No framework, plain fetch + DOM, matching the "plain
// HTML/CSS/JS" spec this tool is built to.

const $ = (id) => document.getElementById(id);
let currentSource = "none";

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Light diff highlighting — colour only, per real unified-diff line prefix. Never changes the text.
function renderDiff(text) {
  return text.split("\n").map((line) => {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    const safe = escapeHtml(line);
    return cls ? `<span class="${cls}">${safe}</span>` : safe;
  }).join("\n");
}

// Summary-line char count (git convention: <=50 ideal, >72 too long) + copy-button enablement.
function updateMsgMeta() {
  const v = $("message").value;
  const n = v.split("\n")[0].length;
  const el = $("charCount");
  el.textContent = `${n} character${n === 1 ? "" : "s"} in the summary line` + (n > 72 ? " — over 72, consider shortening" : "");
  el.style.color = n > 72 ? "var(--dan-red)" : "";
  $("copyMsg").disabled = !v.trim();
}

async function loadStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  if (!data.isRepo) {
    $("status").textContent = `${data.cwd} is not a real git repository.`;
    return false;
  }
  const branch = data.branch ? escapeHtml(data.branch) : "(no branch yet)";
  const commitsNote = data.hasCommits ? "" : " — no commits yet";
  // Real local absolute path (carries the OS username on most machines) never rendered — the
  // repo's own folder name is enough context, matching this product's own "privacy is the
  // architecture" line rather than leaking a filesystem detail nobody asked to see.
  const rawRepoName = data.cwd.split("/").filter(Boolean).pop() || "this repo";
  // Real trademark rule, not cosmetic: "DAN" never appears bare, always bracketed (TRADEMARK.md).
  // A folder literally named "DAN-something" would otherwise print the one bare "DAN" on the
  // whole page — render it as the real product-name form instead of the raw folder slug.
  const danMatch = rawRepoName.match(/^DAN[-_](.+)$/i);
  const repoName = danMatch
    ? `<span class="dan-br">[</span>DAN<span class="dan-br">]</span> ${escapeHtml(danMatch[1].replace(/[-_]/g, " "))}`
    : escapeHtml(rawRepoName);
  $("status").innerHTML = `<strong>${branch}</strong>${commitsNote} — ${repoName}` +
    (data.provider ? "" : ` <span style="color: var(--dan-red)">— no ANTHROPIC_API_KEY / OPENAI_API_KEY set, Generate will fail honestly until one is</span>`);

  // Real disclosure, not a placeholder: names the ACTUAL configured provider, since "on-device" /
  // "privacy is the architecture" sits right above this action in the sidebar and Generate
  // genuinely does send your diff to a real third-party cloud API with your own key — say so
  // plainly rather than let that read as a contradiction.
  const providerName = data.provider === "anthropic" ? "Anthropic" : data.provider === "openai" ? "OpenAI" : null;
  $("providerDisclosure").textContent = providerName
    ? `Generate sends your real diff to ${providerName}'s API, using your own key. Nothing else reads it.`
    : "";
  return true;
}

async function loadDiff() {
  const res = await fetch("/api/diff");
  const data = await res.json();
  if (!data.ok) {
    $("diff").textContent = data.reason;
    return;
  }
  currentSource = data.source;
  if (data.source === "none") {
    $("diff").textContent = "No real changes — nothing staged, nothing unstaged.";
    $("files").innerHTML = "";
    return;
  }
  $("diff").innerHTML = renderDiff(data.diff);
  $("files").innerHTML = data.files
    .map((f) => `<li><span class="file-status ${f.status[0]}">${f.status[0]}</span><span>${escapeHtml(f.path)}</span></li>`)
    .join("") + `<li class="hint" style="margin-top:6px;">source: ${data.source}</li>`;
}

async function generate() {
  const btn = $("generate");
  const status = $("genStatus");
  btn.disabled = true;
  status.innerHTML = `<span class="dan-seal"></span> Reading the real diff and asking the real model…`;
  try {
    const diffRes = await fetch("/api/diff");
    const diffData = await diffRes.json();
    if (!diffData.ok || diffData.source === "none") {
      status.textContent = "No real changes to describe.";
      return;
    }
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ diff: diffData.diff }),
    });
    const data = await res.json();
    if (!data.ok) {
      status.textContent = data.reason;
      return;
    }
    $("message").value = data.message;
    $("commit").disabled = false;
    updateMsgMeta();
    status.textContent = `Generated via ${data.provider}${data.truncated ? " (diff truncated for length)" : ""}.`;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function commit() {
  const status = $("commitStatus");
  const message = $("message").value.trim();
  if (!message) {
    status.textContent = "Write or generate a message first.";
    return;
  }
  const stageAll = $("stageAll").checked && currentSource === "unstaged";
  $("commit").disabled = true;
  status.textContent = "Committing…";
  try {
    const res = await fetch("/api/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, stageAll }),
    });
    const data = await res.json();
    if (!data.ok) {
      status.textContent = data.reason;
      $("commit").disabled = false;
      return;
    }
    status.innerHTML = `Committed — <strong>${data.sha}</strong>`;
    $("message").value = "";
    updateMsgMeta();
    await loadDiff();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    $("commit").disabled = false;
  }
}

$("generate").addEventListener("click", generate);
$("commit").addEventListener("click", commit);
$("message").addEventListener("input", () => { $("commit").disabled = !$("message").value.trim(); updateMsgMeta(); });
$("copyMsg").addEventListener("click", async () => {
  const btn = $("copyMsg");
  try {
    await navigator.clipboard.writeText($("message").value);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1400);
});

(async () => {
  const ok = await loadStatus();
  if (ok) await loadDiff();
})();
