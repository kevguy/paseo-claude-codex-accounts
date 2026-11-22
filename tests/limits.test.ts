import assert from "node:assert/strict";
import test from "node:test";
import { detectLimit } from "../server/limits.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");

test("recognizes Claude session, weekly, model, spend, and credit limits", () => {
  // Claude Code 2.1.328 binary strings: “You've hit your session limit”.
  assert.deepEqual(detectLimit("claude", "You've hit your session limit", NOW), { scope: "session" });
  // Claude Code wording with the typographic apostrophe variant.
  assert.deepEqual(detectLimit("claude", "You’ve hit your session limit", NOW), { scope: "session" });
  // Claude Code 2.1.328 binary strings: “You've hit your weekly limit”.
  assert.deepEqual(detectLimit("claude", "You've hit your weekly limit", NOW), { scope: "weekly" });
  // Claude Code 2.1.328 binary strings: “You've hit your 5-hour limit”.
  assert.deepEqual(detectLimit("claude", "You've hit your 5-hour limit", NOW), { scope: "session" });
  // Claude Code 2.1.328 binary strings: “You've hit your fast limit”.
  assert.deepEqual(detectLimit("claude", "You've hit your fast limit", NOW), { scope: "model", model: "fast" });
  // Claude Code 2.1.328 binary strings: “You've reached your Fable limit”.
  assert.deepEqual(detectLimit("claude", "You've reached your Fable limit", NOW), { scope: "model", model: "fable" });
  // Claude Code 2.1.328 binary strings: “You've reached your Fable limit for this week. Switch models?”
  assert.deepEqual(detectLimit("claude", "You've reached your Fable limit for this week. Switch models?", NOW), { scope: "model", model: "fable" });
  // Claude Code 2.1.328 binary strings contain the “You've hit your ${limit}” template for model limits.
  assert.deepEqual(detectLimit("claude", "You've hit your Opus limit", NOW), { scope: "model", model: "opus" });
  // Claude Code allows a model version between its model name and the word “limit”.
  assert.deepEqual(detectLimit("claude", "You've reached your Sonnet 4.5 limit", NOW), { scope: "model", model: "sonnet" });
  // zerosub/server/limits.ts documents the legacy CLI form; also present in competitor failover tests.
  assert.deepEqual(detectLimit("claude", "Claude AI usage limit reached|1791754200", NOW), { scope: "session", resetsAt: 1791754200000 });
  // Claude Code 2.1.328 binary strings: “You've hit your monthly spend limit.”
  assert.deepEqual(detectLimit("claude", "You've hit your monthly spend limit.", NOW), { scope: "spend" });
  // Claude Code 2.1.328 binary strings: “You've hit your channel's monthly spend limit.”
  assert.deepEqual(detectLimit("claude", "You've hit your channel's monthly spend limit.", NOW), { scope: "spend" });
  // Claude Code 2.1.328 binary strings: “You've hit your team's pooled group budget”.
  assert.deepEqual(detectLimit("claude", "You've hit your team's pooled group budget", NOW), { scope: "spend" });
  // Claude Code 2.1.328 binary strings: “You're out of usage credits”.
  assert.deepEqual(detectLimit("claude", "You're out of usage credits", NOW), { scope: "credits" });
  // Claude Code 2.1.328 binary strings: “You're out of extra usage”.
  assert.deepEqual(detectLimit("claude", "You're out of extra usage", NOW), { scope: "credits" });
  // Claude Code 2.1.328 binary strings: “Your usage allocation has been disabled by your admin”.
  assert.deepEqual(detectLimit("claude", "Your usage allocation has been disabled by your admin", NOW), { scope: "credits" });
  // Claude Code 2.1.328 binary strings: “Usage is paused for your organization. For help, please contact support.”
  assert.deepEqual(detectLimit("claude", "Usage is paused for your organization. For help, please contact support.", NOW), { scope: "spend" });
  // Claude Code 2.1.328 binary strings: “Your group's usage limit is set to $0”.
  assert.deepEqual(detectLimit("claude", "Your group's usage limit is set to $0", NOW), { scope: "spend" });
  // Claude Code 2.1.328 binary strings: “Fable 5 requires usage credits”.
  assert.deepEqual(detectLimit("claude", "Fable 5 requires usage credits.", NOW), { scope: "credits" });
  // Claude Code 2.1.328 binary strings: “Your seat type doesn't include extra usage”.
  assert.deepEqual(detectLimit("claude", "Your seat type doesn't include extra usage", NOW), { scope: "credits" });
});

test("recognizes Codex plan and workspace limits", () => {
  // Codex 0.158.0 binary strings: “You've reached your usage limit.”
  assert.deepEqual(detectLimit("codex", "You've reached your usage limit", NOW), { scope: "session" });
  // Codex API wording with the typographic apostrophe variant.
  assert.deepEqual(detectLimit("codex", "You’ve hit your usage limit", NOW), { scope: "session" });
  // Codex 0.158.0 binary strings: “Your workspace is out of credits. Add credits to continue using Codex.”
  assert.deepEqual(detectLimit("codex", "Your workspace is out of credits. Add credits to continue using Codex.", NOW), { scope: "credits" });
  // zerosub/server/limits.ts contains the Codex raw error discriminator.
  assert.deepEqual(detectLimit("codex", '{"type":"usage_limit_reached"}', NOW), { scope: "session" });
  // zerosub/server/limits.ts contains this Codex wording.
  assert.deepEqual(detectLimit("codex", "The usage limit has been reached. Try again later.", NOW), { scope: "session" });
  // Codex 0.158.0 binary strings: “You've reached your usage limit. Increase your limits to continue using codex.”
  assert.deepEqual(detectLimit("codex", "You've reached your usage limit. Increase your limits to continue using codex.", NOW), { scope: "session" });
  // zerosub/server/limits.ts documents this spend-cap wording.
  assert.deepEqual(detectLimit("codex", "You hit your spend cap", NOW), { scope: "spend" });
});

test("parses durations, epochs, and local reset clocks", () => {
  // Codex 0.158.0 requested runtime wording: “You've hit your usage limit ... try again in 2 hours 5 minutes”.
  assert.deepEqual(detectLimit("codex", "You've hit your usage limit. Try again in 2 hours 5 minutes.", NOW), {
    scope: "session", resetsAt: NOW.getTime() + 125 * 60_000,
  });
  // Codex 0.158.0 error template includes “try again at” with a clock time.
  assert.deepEqual(detectLimit("codex", "You've hit your usage limit. Try again at 4:15 PM", NOW, "UTC"), {
    scope: "session", resetsAt: Date.parse("2026-11-22T16:15:00.000Z"),
  });
  // paseo-seamless-claude-accounts/tests/failover.test.ts: exact fixture.
  assert.deepEqual(detectLimit("claude", "You've hit your session limit · resets 11:30pm (Europe/Berlin)", NOW), {
    scope: "session", resetsAt: Date.parse("2026-11-22T22:30:00.000Z"),
  });
  // paseo-seamless-claude-accounts/tests/failover.test.ts: exact fixture.
  assert.deepEqual(detectLimit("claude", "You've hit your weekly limit · resets Oct 28, 9am", NOW), {
    scope: "weekly", resetsAt: Date.parse("2027-10-28T09:00:00.000Z"),
  });
  // paseo-seamless-claude-accounts/tests/failover.test.ts: exact fixture.
  assert.deepEqual(detectLimit("claude", "You've hit your limit · resets 3pm", new Date("2026-11-22T14:00:00Z"), "UTC"), {
    scope: "session", resetsAt: Date.parse("2026-11-22T15:00:00.000Z"),
  });
  // paseo-seamless-claude-accounts/tests/failover.test.ts: exact fixture.
  assert.deepEqual(detectLimit("claude", "You've hit your Fable limit · resets Nov 3, 1am", NOW), {
    scope: "model", model: "fable", resetsAt: Date.parse("2027-11-03T01:00:00.000Z"),
  });
  // User-specified provider wording variant: “resets 3pm”.
  assert.equal(detectLimit("claude", "You've hit your limit · resets 3pm", new Date("2026-11-22T15:00:00Z"), "UTC")?.resetsAt, Date.parse("2026-11-23T15:00:00Z"));
  // User-specified provider wording variant: “resets 3:30pm (Europe/London)”.
  assert.equal(detectLimit("claude", "You've hit your weekly limit · resets 3:30pm (Europe/London)", NOW)?.resetsAt, Date.parse("2026-11-22T15:30:00Z"));
  // User-specified provider wording variant: “resets Nov 24, 9am”.
  assert.equal(detectLimit("claude", "You've hit your weekly limit · resets Nov 24, 9am", NOW)?.resetsAt, Date.parse("2026-11-24T09:00:00Z"));
  // Codex 0.158.0 error template includes the “try again at” reset form.
  assert.equal(detectLimit("codex", "You've hit your usage limit. Try again at 4:15 PM", new Date("2026-11-22T17:00:00Z"), "UTC")?.resetsAt, Date.parse("2026-11-23T16:15:00Z"));
  // Explicit zone takes priority over the supplied default zone.
  assert.equal(detectLimit("claude", "You've hit your limit · resets 3:30pm (Europe/London)", NOW, "America/Los_Angeles")?.resetsAt, Date.parse("2026-11-22T15:30:00Z"));
  // Without either zone, clock resets are interpreted as UTC.
  assert.equal(detectLimit("claude", "You've hit your limit · resets 3pm", NOW)?.resetsAt, Date.parse("2026-11-22T15:00:00Z"));
  // Unrecognized reset text still identifies a limit and omits an invented timestamp.
  assert.deepEqual(detectLimit("codex", "You've hit your usage limit. Try again after support responds.", NOW), { scope: "session" });
});

test("rejects ordinary limits and transient service errors", () => {
  assert.equal(detectLimit("claude", "Please rate limit the API to 10 calls per second.", NOW), null);
  assert.equal(detectLimit("claude", "The context window limit has been reached.", NOW), null);
  assert.equal(detectLimit("claude", "The file size limit is 10 MB.", NOW), null);
  assert.equal(detectLimit("claude", "Server is temporarily limiting requests (not your usage limit)", NOW), null);
  assert.equal(detectLimit("codex", "HTTP 429 Too Many Requests", NOW), null);
  assert.equal(detectLimit("codex", "The service is overloaded; try again in 2 hours.", NOW), null);
  assert.equal(detectLimit("codex", "Rate limit reached. Try again later.", NOW), null);
  assert.equal(detectLimit("codex", "Your personal account has a usage limit", NOW), null);
  assert.equal(detectLimit("claude", "You've used 80% of your weekly limit", NOW), null);
});
