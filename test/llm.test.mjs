// Real tests for the honest-failure paths and provider-selection logic — never a real network
// call to Anthropic/OpenAI (no test here should need, or spend, a real API key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredProvider, generateCommitMessage } from "../src/llm.js";

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("configuredProvider returns null when neither key is set", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
    assert.equal(configuredProvider(), null);
  }));

test("configuredProvider prefers anthropic when both keys are set (deterministic, not a coin flip)", () =>
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-fake", OPENAI_API_KEY: "sk-fake" }, () => {
    assert.equal(configuredProvider(), "anthropic");
  }));

test("configuredProvider falls back to openai when only that key is set", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-fake" }, () => {
    assert.equal(configuredProvider(), "openai");
  }));

test("generateCommitMessage fails honestly, with no network call, when no key is configured", () =>
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(() => generateCommitMessage("diff --git a/x b/x"), /No API key configured/);
  }));

test("generateCommitMessage fails honestly on an empty diff, before ever calling out", () =>
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-fake" }, async () => {
    await assert.rejects(() => generateCommitMessage("   "), /No real changes to describe/);
  }));
