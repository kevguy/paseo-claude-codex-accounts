import assert from "node:assert/strict";
import test from "node:test";
import type { UsageReport, UsageWindow } from "@getpaseo/plugin/server/usage";
import { accountsFromConfig } from "../server/accounts";
import {
  KeyedLock,
  SwitchGuard,
  accountForNewChat,
  claudeLoginDir,
  currentAccount,
  limitFromFailure,
  pickAccount,
  providerAccount,
  providerKind,
  sessionEnv,
  type Headroom,
} from "../server/switching";
import { HeadroomCache, lookupEnv, summarize, type HeadroomDeps } from "../server/headroom";
import { DEFAULT_SETTINGS, META_ACCOUNT, type SwitchingOptions } from "../shared/switching";
import type { AccountKind } from "../shared/accounts";

const home = "/Users/x";
const host = { homedir: home, platform: "darwin" as const, env: {} };
const providers: Record<string, unknown> = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
  "claude-work": { extends: "claude", label: "Claude Work", env: { CLAUDE_CONFIG_DIR: `${home}/.claude-work` } },
  "claude-team": { extends: "claude", label: "Claude Team", env: { CLAUDE_CONFIG_DIR: `${home}/.claude-team` } },
  "codex-work": { extends: "codex", label: "Codex Work", env: { CODEX_HOME: `${home}/.codex-work` } },
  "claude-proxy": { extends: "claude", label: "Claude Proxy" },
};
const rows = accountsFromConfig(providers, host);
const byId = (id: string) => rows.find((row) => row.id === id)!;

test("providerKind recognizes the built-in Claude provider", () => {
  assert.equal(providerKind("claude", providers), "claude");
});
test("providerKind recognizes the built-in Codex provider", () => {
  assert.equal(providerKind("codex", providers), "codex");
});
test("providerKind recognizes a custom provider extending Claude", () => {
  assert.equal(providerKind("claude-work", providers), "claude");
});
test("providerKind recognizes a custom provider extending Codex", () => {
  assert.equal(providerKind("codex-work", providers), "codex");
});
test("providerKind recognizes the built-in model provider form", () => {
  assert.equal(providerKind("claude/sonnet", providers), "claude");
});
test("providerKind returns null for unknown providers and extensions", () => {
  assert.equal(providerKind("unknown", providers), null);
  assert.equal(providerKind("not-real", { "not-real": { extends: "other" } }), null);
});

test("providerAccount uses a custom provider's own account", () => {
  assert.equal(providerAccount("claude-work", rows, providers)?.id, "claude-work");
});
test("providerAccount maps a built-in provider to its default account", () => {
  assert.equal(providerAccount("codex", rows, providers)?.id, "codex");
});
test("providerAccount maps a custom provider without its own folder to the kind default", () => {
  assert.equal(providerAccount("claude-proxy", rows, providers)?.id, "claude");
});
test("providerAccount returns null for an unknown provider kind", () => {
  assert.equal(providerAccount("unknown", rows, providers), null);
});

test("claudeLoginDir leaves the default login variable empty", () => {
  assert.equal(claudeLoginDir(byId("claude")), "");
});
test("claudeLoginDir uses the default account home when it has an env override", () => {
  const overridden = accountsFromConfig({ claude: { env: { CLAUDE_CONFIG_DIR: "/custom/claude" } } }, host)[0]!;
  assert.equal(overridden.id, "claude");
  assert.equal(claudeLoginDir(overridden), "/custom/claude");
});
test("claudeLoginDir uses an extra account's home", () => {
  assert.equal(claudeLoginDir(byId("claude-work")), `${home}/.claude-work`);
});

test("currentAccount accepts metadata for an existing account of the provider kind", () => {
  assert.equal(currentAccount({ provider: "claude", metadata: { [META_ACCOUNT]: "claude-team" } }, rows, providers)?.id, "claude-team");
});
test("currentAccount ignores metadata for an account of another kind", () => {
  assert.equal(currentAccount({ provider: "claude", metadata: { [META_ACCOUNT]: "codex-work" } }, rows, providers)?.id, "claude");
});
test("currentAccount ignores metadata for a removed account", () => {
  assert.equal(currentAccount({ provider: "claude", metadata: { [META_ACCOUNT]: "claude-gone" } }, rows, providers)?.id, "claude");
});
test("currentAccount falls back to the provider account without metadata", () => {
  assert.equal(currentAccount({ provider: "claude-work" }, rows, providers)?.id, "claude-work");
});

test("sessionEnv leaves Codex sessions alone", () => {
  assert.equal(sessionEnv({ provider: "codex", metadata: { [META_ACCOUNT]: "claude-work" } }, rows, providers), null);
});
test("sessionEnv leaves sessions alone when there is no account metadata", () => {
  assert.equal(sessionEnv({ provider: "claude", metadata: {} }, rows, providers), null);
});
test("sessionEnv leaves the provider's own account unchanged", () => {
  assert.equal(sessionEnv({ provider: "claude-work", metadata: { [META_ACCOUNT]: "claude-work" } }, rows, providers), null);
});
test("sessionEnv selects another Claude account's secure-storage folder", () => {
  assert.deepEqual(sessionEnv({ provider: "claude-work", metadata: { [META_ACCOUNT]: "claude-team" } }, rows, providers), {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: `${home}/.claude-team`,
  });
});
test("sessionEnv leaves a removed account to the provider fallback", () => {
  assert.equal(sessionEnv({ provider: "claude-work", metadata: { [META_ACCOUNT]: "claude-removed" } }, rows, providers), null);
});
test("sessionEnv selects the default account with an empty secure-storage value", () => {
  assert.deepEqual(sessionEnv({ provider: "claude-work", metadata: { [META_ACCOUNT]: "claude" } }, rows, providers), {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
  });
});

type Candidate = (typeof rows)[number] & { state: "signed-in" | "signed-out" | "unknown" };
const candidates = (states: Record<string, Candidate["state"]> = {}): Candidate[] => rows.filter((row) => row.kind === "claude").map((row) => ({
  ...row,
  state: states[row.id] ?? "signed-in",
}));

test("pickAccount filters signed-out and unknown-status rows", () => {
  const list = candidates({ "claude-work": "signed-out", "claude-team": "unknown" });
  assert.equal(pickAccount(list, new Map(), new Map(), 100)?.id, "claude");
});
test("pickAccount filters disabled rows", () => {
  const disabled = accountsFromConfig({ ...providers, "claude-work": { ...providers["claude-work"] as object, enabled: false } }, host)
    .map((row) => ({ ...row, state: "signed-in" as const }));
  assert.equal(pickAccount(disabled, new Map([["claude-work", { usedPct: 0 }]]), new Map(), 100)?.id, "claude");
});
test("pickAccount filters excluded ids", () => {
  assert.equal(pickAccount(candidates(), new Map(), new Map(), 100, { exclude: ["claude"] })?.id, "claude-team");
});
test("pickAccount filters accounts limited until a future time", () => {
  const limited = new Map([["claude", { until: 101 }]]);
  assert.equal(pickAccount(candidates(), new Map(), limited, 100)?.id, "claude-team");
});
test("pickAccount considers a limit expired at its boundary", () => {
  const limited = new Map([["claude", { until: 100 }]]);
  assert.equal(pickAccount(candidates(), new Map(), limited, 100)?.id, "claude");
});
test("pickAccount treats unknown usage as 90 percent", () => {
  const list = candidates();
  assert.equal(pickAccount(list, new Map([["claude", { usedPct: 95 }], ["claude-work", { usedPct: 95 }]]), new Map(), 0)?.id, "claude-team");
});
test("pickAccount chooses the smallest known used percentage", () => {
  assert.equal(pickAccount(candidates(), new Map([
    ["claude", { usedPct: 50 }], ["claude-work", { usedPct: 10 }], ["claude-team", { usedPct: 30 }],
  ]), new Map(), 0)?.id, "claude-work");
});
test("pickAccount honors maxUsedPct", () => {
  const readings = new Map<string, Headroom>([["claude", { usedPct: 80 }], ["claude-work", { usedPct: 95 }]]);
  assert.equal(pickAccount(candidates(), readings, new Map(), 0, { maxUsedPct: 90 })?.id, "claude");
});
test("pickAccount returns null if every candidate is filtered", () => {
  assert.equal(pickAccount(candidates({ claude: "signed-out" }), new Map(), new Map(), 0, { exclude: ["claude-work", "claude-team"] }), null);
});

const bestClaude = () => byId("claude-team");
const best = (kind: AccountKind) => kind === "claude" ? bestClaude() : byId("codex-work");
const settings = (overrides: Partial<SwitchingOptions> = {}): SwitchingOptions => ({ ...DEFAULT_SETTINGS, ...overrides });
const chat = (provider: string, metadata?: Record<string, string>) => ({ provider, cwd: `${home}/work/app`, ...(metadata ? { metadata } : {}) });

test("accountForNewChat chooses the best account for the auto selection", () => {
  assert.deepEqual(accountForNewChat(chat("claude", { [META_ACCOUNT]: "auto" }), rows, providers, settings(), best, { homedir: home, platform: "darwin" }), {
    row: byId("claude-team"), why: "headroom",
  });
});
test("accountForNewChat honors an explicit same-kind account", () => {
  assert.equal(accountForNewChat(chat("claude", { [META_ACCOUNT]: "claude-work" }), rows, providers, settings(), best, { homedir: home, platform: "darwin" })?.why, "explicit");
});
test("accountForNewChat rejects an explicit account of the wrong kind", () => {
  assert.equal(accountForNewChat(chat("claude", { [META_ACCOUNT]: "codex-work" }), rows, providers, settings(), best, { homedir: home, platform: "darwin" }), null);
});
test("accountForNewChat leaves an account-specific provider alone", () => {
  assert.equal(accountForNewChat(chat("claude-work"), rows, providers, settings({ newChats: "most-headroom" }), best, { homedir: home, platform: "darwin" }), null);
});
test("accountForNewChat chooses a matching folder rule", () => {
  const configured = settings({ rules: [{ pattern: "~/work/**", accountId: "claude-work" }] });
  const result = accountForNewChat(chat("claude"), rows, providers, configured, best, { homedir: home, platform: "darwin" });
  assert.deepEqual(result, { row: byId("claude-work"), why: "rule" });
});
test("accountForNewChat uses most-headroom when configured", () => {
  assert.equal(accountForNewChat(chat("claude"), rows, providers, settings({ newChats: "most-headroom" }), best, { homedir: home, platform: "darwin" })?.why, "headroom");
});
test("accountForNewChat keeps the picker choice when picker mode is configured", () => {
  assert.equal(accountForNewChat(chat("claude"), rows, providers, settings({ newChats: "picker" }), best, { homedir: home, platform: "darwin" }), null);
});

test("SwitchGuard allows four switches and blocks the fifth inside ten minutes", () => {
  const guard = new SwitchGuard();
  for (let i = 0; i < 4; i++) {
    assert.equal(guard.allow("agent", i), true);
    guard.record("agent", i);
  }
  assert.equal(guard.allow("agent", 4), false);
});
test("SwitchGuard slides its ten-minute window", () => {
  const guard = new SwitchGuard();
  for (let i = 0; i < 4; i++) guard.record("agent", i);
  assert.equal(guard.allow("agent", 10 * 60_000), true);
});
test("SwitchGuard keeps histories separate by agent", () => {
  const guard = new SwitchGuard();
  for (let i = 0; i < 4; i++) guard.record("one", i);
  assert.equal(guard.allow("two", 4), true);
});

test("KeyedLock serializes work on the same key", async () => {
  const lock = new KeyedLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = lock.run("same", async () => { order.push("first:start"); await gate; order.push("first:end"); });
  const second = lock.run("same", async () => { order.push("second:start"); });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});
test("KeyedLock allows parallel work on different keys", async () => {
  const lock = new KeyedLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  let ready!: () => void;
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  const work = (key: string) => lock.run(key, async () => {
    started.push(key);
    if (started.length === 2) ready();
    await gate;
  });
  const one = work("one");
  const two = work("two");
  await bothStarted;
  assert.deepEqual(new Set(started), new Set(["one", "two"]));
  release();
  await Promise.all([one, two]);
});
test("KeyedLock continues queued work after a rejection", async () => {
  const lock = new KeyedLock();
  const failed = lock.run("key", async () => { throw new Error("expected failure"); });
  const continued = lock.run("key", async () => "continued");
  await assert.rejects(failed, /expected failure/);
  assert.equal(await continued, "continued");
});

test("limitFromFailure uses a detected limit reset time", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(limitFromFailure("claude", "You've hit your 5-hour limit. Try again in 2 hours", now), {
    until: now.getTime() + 2 * 60 * 60_000,
  });
});
test("limitFromFailure falls back to one hour when no reset is detected", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(limitFromFailure("codex", "You've hit your usage limit", now), { until: now.getTime() + 60 * 60_000 });
});
test("limitFromFailure returns null for an unrelated failure", () => {
  assert.equal(limitFromFailure("claude", "Network request failed", new Date()), null);
});

const availableReport = (windows: UsageWindow[]): UsageReport => ({ status: "available", windows });

test("summarize returns null usage for an unavailable report", () => {
  assert.deepEqual(summarize({ status: "unavailable", problem: { kind: "no_quota", detail: "No quota" } }), { usedPct: null });
});
test("summarize returns null usage for an error report", () => {
  assert.deepEqual(summarize({ status: "error", error: "Unavailable" }), { usedPct: null });
});
test("summarize labels summary windows and omits non-summary windows", () => {
  const report = availableReport([
    { id: "session", label: "5 hours", shortLabel: "5h", summary: true, usedPct: 42 },
    { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 18 },
    { id: "hidden", label: "Hidden", shortLabel: "hid", summary: false, usedPct: 11 },
  ]);
  assert.deepEqual(summarize(report), { usedPct: 42, summary: "5h 42% · wk 18%" });
});
test("summarize uses the maximum over every included window", () => {
  assert.equal(summarize(availableReport([
    { id: "session", label: "Session", summary: true, usedPct: 51 },
    { id: "long", label: "Long window", summary: true, usedPct: 77 },
  ])).usedPct, 77);
});

test("lookupEnv omits the provider variable for a default account", () => {
  const env = lookupEnv(byId("claude"), { env: { HOME: "/runtime/home", USER: "test" }, homedir: home });
  assert.deepEqual(env, { HOME: "/runtime/home", USER: "test" });
  assert.equal("CLAUDE_CONFIG_DIR" in env, false);
});
test("lookupEnv supplies the provider variable for an extra account", () => {
  const env = lookupEnv(byId("codex-work"), { env: { HOME: "/runtime/home", USERPROFILE: "C:\\Users\\x" }, homedir: home });
  assert.deepEqual(env, { HOME: "/runtime/home", USERPROFILE: "C:\\Users\\x", CODEX_HOME: `${home}/.codex-work` });
});

function cacheDeps(options: { now?: () => number; discover?: HeadroomDeps["discover"]; fetch?: HeadroomDeps["fetch"] } = {}): HeadroomDeps {
  return {
    env: { HOME: "/runtime/home" },
    homedir: home,
    now: options.now ?? (() => 0),
    discover: options.discover ?? { claude: async () => [{ key: "claude", input: { id: "claude" } }], codex: async () => [{ key: "codex", input: { id: "codex" } }] },
    fetch: options.fetch ?? { claude: async () => availableReport([{ id: "session", label: "Session", shortLabel: "5h", usedPct: 42 }]), codex: async () => availableReport([{ id: "week", label: "Week", shortLabel: "wk", usedPct: 18 }]) },
  };
}

test("HeadroomCache deduplicates simultaneous reads for one account", async () => {
  let resolveDiscover!: (value: { key: string; input: { id: string } }[]) => void;
  const waiting = new Promise<{ key: string; input: { id: string } }[]>((resolve) => { resolveDiscover = resolve; });
  let discoverCalls = 0;
  let fetchCalls = 0;
  const cache = new HeadroomCache(cacheDeps({
    discover: { claude: async () => { discoverCalls++; return waiting; }, codex: async () => [] },
    fetch: { claude: async () => { fetchCalls++; return availableReport([{ id: "s", label: "S", usedPct: 30 }]); }, codex: async () => ({ status: "error", error: "unused" }) },
  }));
  const one = cache.get(byId("claude"));
  const two = cache.get(byId("claude"));
  await Promise.resolve();
  assert.equal(discoverCalls, 1);
  resolveDiscover([{ key: "claude", input: { id: "claude" } }]);
  assert.deepEqual(await Promise.all([one, two]), [{ usedPct: 30, summary: "S 30%" }, { usedPct: 30, summary: "S 30%" }]);
  assert.equal(fetchCalls, 1);
});
test("HeadroomCache respects the 90-second minimum interval", async () => {
  let now = 0;
  let reads = 0;
  const cache = new HeadroomCache(cacheDeps({
    now: () => now,
    fetch: { claude: async () => { reads++; return availableReport([{ id: "s", label: "S", usedPct: reads * 10 }]); }, codex: async () => ({ status: "error", error: "unused" }) },
  }));
  assert.equal((await cache.get(byId("claude"), 1)).usedPct, 10);
  now = 89_999;
  assert.equal((await cache.get(byId("claude"), 1)).usedPct, 10);
  assert.equal(reads, 1);
  now = 90_000;
  assert.equal((await cache.get(byId("claude"), 1)).usedPct, 20);
  assert.equal(reads, 2);
});
test("HeadroomCache refreshes readings after the requested max age", async () => {
  let now = 0;
  let reads = 0;
  const cache = new HeadroomCache(cacheDeps({
    now: () => now,
    fetch: { claude: async () => { reads++; return availableReport([{ id: "s", label: "S", usedPct: reads * 10 }]); }, codex: async () => ({ status: "error", error: "unused" }) },
  }));
  await cache.get(byId("claude"), 90_000);
  now = 90_001;
  assert.equal((await cache.get(byId("claude"), 90_000)).usedPct, 20);
  assert.equal(reads, 2);
});
test("HeadroomCache records a failed read as unknown usage", async () => {
  const cache = new HeadroomCache(cacheDeps({ discover: {
    claude: async () => { throw new Error("read failed"); }, codex: async () => [],
  } }));
  assert.deepEqual(await cache.get(byId("claude")), { usedPct: null });
  assert.deepEqual(cache.peek("claude"), { usedPct: null });
});
test("HeadroomCache snapshot leaves out readings older than the age asked for", async () => {
  let now = 0;
  const cache = new HeadroomCache(cacheDeps({ now: () => now }));
  await cache.get(byId("claude"));
  now = 11 * 60_000;
  await cache.get(byId("codex"));
  assert.deepEqual([...cache.snapshot(10 * 60_000).keys()], ["codex"]);
  assert.deepEqual([...cache.snapshot().keys()].sort(), ["claude", "codex"]);
});
test("HeadroomCache refresh stops waiting on a usage endpoint that hangs", async () => {
  const cache = new HeadroomCache(cacheDeps({ fetch: {
    claude: () => new Promise(() => undefined), codex: async () => availableReport([{ id: "week", label: "Week", shortLabel: "wk", usedPct: 18 }]),
  } }));
  const started = Date.now();
  await cache.refresh([byId("claude"), byId("codex")], 0, 50);
  assert.ok(Date.now() - started < 1000);
  assert.equal(cache.peek("claude"), undefined);
  assert.equal(cache.peek("codex")?.usedPct, 18);
});
test("HeadroomCache exposes cached readings through snapshot", async () => {
  const cache = new HeadroomCache(cacheDeps());
  await cache.get(byId("claude"));
  assert.deepEqual(cache.snapshot().get("claude"), { usedPct: 42, summary: "5h 42%" });
});
