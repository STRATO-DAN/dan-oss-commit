// Real, runnable example — uses this package's own library functions directly, not the CLI/UI.
// Run it from inside any real git repo (including this one):
//
//   node examples/read-diff-and-generate.mjs
//   node examples/read-diff-and-generate.mjs /path/to/some/other/repo
//
// Shows the real diff dan-oss-commit would show you, and generates a real commit message from
// it if you have ANTHROPIC_API_KEY or OPENAI_API_KEY set — same two functions the UI itself
// calls, `realDiff` and `generateCommitMessage`, nothing re-implemented for the example.
import { realDiff, currentBranch } from "../src/git.js";
import { generateCommitMessage, configuredProvider } from "../src/llm.js";

const cwd = process.argv[2] || process.cwd();

const branch = await currentBranch(cwd);
console.log(`Repo: ${cwd}`);
console.log(`Branch: ${branch ?? "(detached HEAD)"}`);

const { diff, source } = await realDiff(cwd);

if (source === "none") {
  console.log("No staged or unstaged changes — nothing to show or generate from.");
  process.exit(0);
}

console.log(`\nReal diff (${source}), ${diff.length} chars:\n`);
console.log(diff.slice(0, 2000) + (diff.length > 2000 ? "\n... (truncated for this example)" : ""));

const provider = configuredProvider();
if (!provider) {
  console.log("\nNo ANTHROPIC_API_KEY or OPENAI_API_KEY set — skipping message generation.");
  console.log("This is the same honest message the real UI shows; nothing is fabricated here.");
  process.exit(0);
}

console.log(`\nGenerating a real commit message via ${provider}...`);
const { message } = await generateCommitMessage(diff);
console.log(`\nGenerated message:\n\n${message}`);
