import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ConfigApi, Host } from "../server/accounts";
import { accountsFromConfig } from "../server/accounts";
import { CONTINUE_PROMPT, RESUME_PROMPT } from "../server/switching";
import { AccountsRuntime, DEFAULT_SETTINGS, type RuntimeDeps } from "../server/runtime";
import type { HeadroomDeps } from "../server/headroom";
import { AUTO_ACCOUNT, LABEL_ACCOUNT, META_ACCOUNT, META_AGENT, type SwitchingOptions } from "../shared/switching";
import type { AccountKind } from "../shared/accounts";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

const fixtureRoot = join(process.cwd(), ".validation", "runtime");
const home = "/not-used";
const fixedNow = Date.UTC(2026, 0, 1, 14, 0, 0);

function initialProviders(root: string, extraClaude = 2): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {
    claude: { label: "Claude" },
    codex: { label: "Codex" },
    "claude-work": { extends: "claude", label: "Claude Work", env: { CLAUDE_CONFIG_DIR: join(root, ".claude-work") } },
    "claude-team": { extends: "claude", label: "Claude Team", env: { CLAUDE_CONFIG_DIR: join(root, ".claude-team") } },
    "codex-work": { extends: "codex", label: "Codex Work", env: { CODEX_HOME: join(root, ".codex-work") } },
  };
  for (let i = 3; i <= extraClaude; i++) {
    const id = `claude-extra-${i}`;
    entries[id] = { extends: "claude", label: `Claude Extra ${i}`, env: { CLAUDE_CONFIG_DIR: join(root, `.${id}`) } };
  }
  return entries;
}

function fakeConfig(initial: Record<string, Record<string, unknown>>) {
  const providers = structuredClone(initial);
  const calls: unknown[] = [];
  let getGate: Promise<void> | null = null;
  let gateOnce = false;
  let getError: Error | null = null;
  const api: ConfigApi = {
    async get() {
      if (getError) { const error = getError; getError = null; throw error; }
      if (getGate && !gateOnce) { gateOnce = true; await getGate; }
      return { config: { providers: structuredClone(providers) } };
    },
    async patch(patch) {
      calls.push(structuredClone(patch));
      for (const id of patch.removeProviders ?? []) delete providers[id];
      for (const [id, entry] of Object.entries(patch.providers ?? {})) providers[id] = { ...providers[id], ...entry };
      return {};
    },
  };
  return { api, providers, calls, pauseNextGet(gate: Promise<void>) { getGate = gate; gateOnce = false; }, failNextGet(error: Error) { getError = error; } };
}

interface HarnessOptions {
  settings?: Partial<SwitchingOptions>;
  providers?: (root: string) => Record<string, Record<string, unknown>>;
  signedOut?: string[];
  usage?: Record<string, number | null>;
  onReload?: () => void | Promise<void>;
  manualIdleWaitMs?: number;
}

async function createHarness(options: HarnessOptions = {}) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = join(fixtureRoot, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  const config = fakeConfig((options.providers ?? initialProviders)(root));
  const configRows = accountsFromConfig(config.providers, { homedir: root, platform: "linux", env: {} });
  const signedOut = new Set(options.signedOut ?? []);

  for (const row of configRows) {
    if (signedOut.has(row.id)) continue;
    if (row.kind === "claude") {
      await mkdir(row.home, { recursive: true });
      await writeFile(join(row.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-only" } }));
      if (row.isDefault) {
        await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "test@example.invalid" } }));
      }
    } else {
      await mkdir(row.home, { recursive: true });
      await writeFile(join(row.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-only" }));
    }
  }

  const nowRef = { value: fixedNow };
  const used = { claude: 40, codex: 40, ...(options.usage ?? {}) } as Record<string, number | null>;
  const accountByHome = new Map(configRows.map((row) => [row.home, row.id]));
  const discoverOne = async (kind: AccountKind, scope: { kind: "global" } | { kind: "session"; env: Record<string, string> }) => {
    if (scope.kind !== "session") return [];
    const envKey = kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const id = scope.env[envKey] ? accountByHome.get(scope.env[envKey]!) : kind;
    return id ? [{ key: id, input: { accountId: id } }] : [];
  };
  const usageReport = (input: unknown): UsageReport => {
    const id = (input as { accountId?: string } | null)?.accountId ?? "";
    const pct = used[id] ?? used[id.split("-")[0]!] ?? 40;
    return pct === null
      ? { status: "unavailable", problem: { kind: "no_quota", detail: "No reading" } }
      : { status: "available", windows: [{ id: "session", label: "Session", shortLabel: "5h", usedPct: pct }] };
  };
  const headroom: HeadroomDeps = {
    env: { HOME: root }, homedir: root,
    discover: { claude: (scope) => discoverOne("claude", scope), codex: (scope) => discoverOne("codex", scope) },
    fetch: { claude: async (input) => usageReport(input), codex: async (input) => usageReport(input) },
    now: () => nowRef.value,
  };
  const statusById = new Map(configRows.map((row) => [row.id, signedOut.has(row.id) ? "signed-out" : "signed-in"]));
  const calls = { refresh: 0, metadata: [] as Record<string, unknown>[], reload: 0, send: [] as string[], timeline: [] as any[] };
  let reloadError: Error | null = null;
  const agent: any = {
    id: "agent-1", provider: "claude", cwd: root, status: "idle", metadata: {}, archivedAt: null,
  };
  const handle = {
    async refresh() { calls.refresh++; },
    current() { return agent; },
    async setMetadata(patch: Record<string, unknown>) {
      calls.metadata.push(structuredClone(patch));
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete agent.metadata[key];
        else agent.metadata[key] = value;
      }
    },
    async reload() { calls.reload++; if (reloadError) throw reloadError; },
    async send(text: string) { calls.send.push(text); },
    timeline: { async append(item: unknown) { calls.timeline.push(item); } },
  };
  const paseo = { agents: { ref(id: string) { assert.equal(id, agent.id); return handle; } } } as any;
  let settings: SwitchingOptions = { ...DEFAULT_SETTINGS, ...options.settings };
  const logs: string[] = [];
  const runtimeDeps: RuntimeDeps = {
    host() {
      const fakeHost: Host = { config: config.api, homedir: root, platform: "linux", env: {}, keychainHas: async () => false };
      return fakeHost;
    },
    settings: async () => settings,
    headroom,
    now: () => nowRef.value,
    log: (message) => logs.push(message),
    ...(options.manualIdleWaitMs ? { manualIdleWaitMs: options.manualIdleWaitMs } : {}),
  };
  const runtime = new AccountsRuntime(runtimeDeps);
  return {
    root, runtime, paseo, agent, handle, calls, logs, config, rows: configRows,
    nowRef, used, statusById,
    settings(value: Partial<SwitchingOptions>) { settings = { ...settings, ...value }; },
    failReload(message = "refresh failed") { reloadError = new Error(message); },
    async close() { runtime.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

async function withHarness(run: (h: Awaited<ReturnType<typeof createHarness>>) => Promise<void>, options: HarnessOptions = {}) {
  const h = await createHarness(options);
  try { await run(h); } finally { await h.close(); }
}

type CreatePayload = Parameters<AccountsRuntime["onCreate"]>[0];
type OpenPayload = Parameters<AccountsRuntime["onOpen"]>[0];
type TurnEndPayload = Parameters<AccountsRuntime["onTurnEnd"]>[0];
function createPayload(provider = "claude", metadata: Record<string, unknown> = {}, cwd = "/work/app"): CreatePayload {
  return { request: { config: { provider, cwd }, metadata } } as unknown as CreatePayload;
}
function openPayload(options: Partial<{ provider: string; metadata: Record<string, unknown>; labels: Record<string, string>; reason: string; purpose: string; tools: unknown[]; env: Record<string, string>; agentId: string }> = {}): OpenPayload {
  return { request: {
    provider: "claude", metadata: {}, labels: {}, reason: "resume", purpose: "background", tools: [], env: {}, agentId: "agent-1", ...options,
  } } as unknown as OpenPayload;
}
function turnPayload(h: Awaited<ReturnType<typeof createHarness>>, outcome: any): TurnEndPayload {
  return { agent: h.agent, outcome } as unknown as TurnEndPayload;
}
const failure = (message: string): any => ({ kind: "failed", error: new Error(message) });
const completed: any = { kind: "completed" };

test("onCreate writes the account selected by a Claude folder rule", async () => withHarness(async (h) => {
  h.settings({ rules: [{ pattern: "/work/**", accountId: "claude-work" }] });
  const result = await h.runtime.onCreate(createPayload(), h.paseo);
  assert.equal(result?.metadata?.[META_ACCOUNT], "claude-work");
}));
test("onCreate changes provider for a Codex folder-rule account", async () => withHarness(async (h) => {
  h.settings({ rules: [{ pattern: "/work/**", accountId: "codex-work" }] });
  const result = await h.runtime.onCreate(createPayload("codex"), h.paseo);
  assert.equal(result?.config.provider, "codex-work");
  assert.equal(result?.metadata?.[META_ACCOUNT], "codex-work");
}));
test("onCreate honors an explicit account over a folder rule", async () => withHarness(async (h) => {
  h.settings({ rules: [{ pattern: "/work/**", accountId: "claude-work" }] });
  const result = await h.runtime.onCreate(createPayload("claude", { [META_ACCOUNT]: "claude-team" }), h.paseo);
  assert.equal(result?.metadata?.[META_ACCOUNT], "claude-team");
}));
test("onCreate resolves auto to the signed-in account with most headroom", async () => withHarness(async (h) => {
  h.used.claude = 90; h.used["claude-work"] = 20; h.used["claude-team"] = 5;
  const work = h.rows.find((row) => row.id === "claude-work")!;
  const team = h.rows.find((row) => row.id === "claude-team")!;
  await h.runtime.headroom.get(work);
  await h.runtime.headroom.get(team);
  const result = await h.runtime.onCreate(createPayload("claude", { [META_ACCOUNT]: AUTO_ACCOUNT }), h.paseo);
  assert.equal(result?.metadata?.[META_ACCOUNT], "claude-team");
}));
test("onCreate removes auto metadata if no account is usable", async () => withHarness(async (h) => {
  for (const id of ["claude", "claude-work", "claude-team"]) await h.config.api.patch({ providers: { [id]: { enabled: false } } });
  const result = await h.runtime.onCreate(createPayload("claude", { [META_ACCOUNT]: AUTO_ACCOUNT }), h.paseo);
  assert.equal(result?.metadata?.[META_ACCOUNT], undefined);
}));

test("onOpen sets the secure-storage env for another account", async () => withHarness(async (h) => {
  h.agent.metadata[META_ACCOUNT] = "claude-team";
  const result = await h.runtime.onOpen(openPayload({ metadata: h.agent.metadata }), h.paseo);
  assert.equal(result?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(h.root, ".claude-team"));
}));
test("onOpen leaves the env alone for the provider's own account", async () => withHarness(async (h) => {
  h.agent.metadata[META_ACCOUNT] = "claude";
  const result = await h.runtime.onOpen(openPayload({ metadata: h.agent.metadata }), h.paseo);
  assert.equal(result, undefined);
}));
test("onOpen applies an account label on create and schedules metadata persistence", async () => withHarness(async (h) => {
  const result = await h.runtime.onOpen(openPayload({ reason: "create", labels: { [LABEL_ACCOUNT]: "claude-work" } }), h.paseo);
  assert.equal(result?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(h.root, ".claude-work"));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(h.calls.metadata.some((patch) => patch[META_ACCOUNT] === "claude-work"));
}));
test("onOpen applies an account label on import", async () => withHarness(async (h) => {
  const result = await h.runtime.onOpen(openPayload({ reason: "import", labels: { [LABEL_ACCOUNT]: "claude-team" } }), h.paseo);
  assert.equal(result?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(h.root, ".claude-team"));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(h.calls.metadata.some((patch) => patch[META_ACCOUNT] === "claude-team"));
}));
test("onOpen ignores account labels on resume", async () => withHarness(async (h) => {
  await h.runtime.onOpen(openPayload({ reason: "resume", labels: { [LABEL_ACCOUNT]: "claude-work" } }), h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(h.calls.metadata.some((patch) => META_ACCOUNT in patch), false);
}));
test("onOpen ignores a label naming an account of the wrong kind", async () => withHarness(async (h) => {
  const result = await h.runtime.onOpen(openPayload({ provider: "claude", reason: "import", labels: { [LABEL_ACCOUNT]: "codex-work" } }), h.paseo);
  assert.equal(result, undefined);
  assert.ok(h.logs.some((line) => line.includes("doesn't name a Claude account")));
}));
test("onOpen doesn't record a Codex label, since a Codex chat can't change login", async () => withHarness(async (h) => {
  const result = await h.runtime.onOpen(openPayload({ provider: "codex", reason: "create", labels: { [LABEL_ACCOUNT]: "codex-work" } }), h.paseo);
  assert.equal(result, undefined);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.calls.metadata.some((patch) => META_ACCOUNT in patch), false);
  assert.ok(h.logs.some((line) => line.includes("--provider codex-work")));
}));
test("onOpen lets the chat open when the accounts can't be read", async () => withHarness(async (h) => {
  h.config.failNextGet(new Error("config unavailable"));
  const result = await h.runtime.onOpen(openPayload({ reason: "resume", metadata: { [META_AGENT]: "agent-1" } }), h.paseo);
  assert.equal(result, undefined);
}));
test("onOpen adds the two account tools when enabled for interactive chats", async () => withHarness(async (h) => {
  h.settings({ agentTools: true });
  const result = await h.runtime.onOpen(openPayload({ purpose: "interactive", metadata: { [META_AGENT]: "agent-1" } }), h.paseo);
  assert.deepEqual(result?.tools?.map((tool: any) => tool.name), ["accounts_list", "accounts_switch"]);
}));

test("onTurnEnd fails over after a Claude limit and records, reloads, and resumes", async () => withHarness(async (h) => {
  await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
  assert.ok(["claude-work", "claude-team"].includes(h.agent.metadata[META_ACCOUNT]));
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "limit");
  assert.equal(h.calls.send.at(-1), CONTINUE_PROMPT);
}));
test("onTurnEnd does not resume after the user starts another turn during failover", async () => withHarness(async (h) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.config.pauseNextGet(gate);
  const promise = h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.nowRef.value += 1;
  h.runtime.onTurnStart({ agent: h.agent } as any);
  release();
  await promise;
  assert.equal(h.calls.send.length, 0);
}));
test("onTurnEnd uses a 100 percent usage reading when the error text is unfamiliar", async () => withHarness(async (h) => {
  h.used.claude = 100;
  h.used["claude-work"] = 30;
  h.used["claude-team"] = 50;
  await h.runtime.onTurnEnd(turnPayload(h, failure("Request was rejected by the provider")), h.paseo);
  assert.ok(h.agent.metadata[META_ACCOUNT] !== undefined);
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "limit");
}));
test("onTurnEnd ignores unfamiliar failures below 100 percent usage", async () => withHarness(async (h) => {
  h.used.claude = 40;
  await h.runtime.onTurnEnd(turnPayload(h, failure("Request was rejected by the provider")), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], undefined);
  assert.equal(h.calls.timeline.length, 0);
}));
test("onTurnEnd records a stuck row when all Claude accounts are limited", async () => withHarness(async (h) => {
  for (const row of h.rows.filter((item) => item.kind === "claude")) h.runtime.limited.set(row.id, { until: h.nowRef.value + 60_000 });
  await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "stuck");
  assert.equal(h.calls.reload, 0);
}));
test("waitForReset schedules a resume prompt when the timer expires", async () => withHarness(async (h) => {
  for (const row of h.rows.filter((item) => item.kind === "claude")) h.runtime.limited.set(row.id, { until: h.nowRef.value + 60_000 });
  const original = globalThis.setTimeout;
  let scheduledDelay = 0;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
    scheduledDelay = Number(delay ?? 0);
    return original(callback, Math.min(scheduledDelay, 5), ...args);
  }) as typeof setTimeout;
  try {
    h.settings({ waitForReset: true });
    await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
    assert.ok(scheduledDelay >= 60_000);
    await new Promise((resolve) => original(resolve, 30));
    assert.equal(h.calls.send.at(-1), RESUME_PROMPT);
  } finally {
    globalThis.setTimeout = original;
  }
}));
test("the automatic-move guard blocks the fifth move within ten minutes", async () => withHarness(async (h) => {
  const accounts = h.rows.filter((row) => row.kind === "claude");
  for (let index = 0; index < 5; index++) {
    h.nowRef.value = fixedNow + index * 1000;
    await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
  }
  assert.equal(h.calls.reload, 4);
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "stuck");
  assert.ok(accounts.length >= 5);
} , { providers: (root) => initialProviders(root, 5) }));
test("Codex limit failure records stuck without moving the chat", async () => withHarness(async (h) => {
  h.agent.provider = "codex";
  h.agent.metadata[META_ACCOUNT] = "codex";
  await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your usage limit · resets 3pm (UTC)")), h.paseo);
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "stuck");
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.send.length, 0);
}));
test("a successful turn above the threshold moves for headroom without sending", async () => withHarness(async (h) => {
  h.agent.metadata[META_ACCOUNT] = "claude";
  h.used.claude = 96; h.used["claude-work"] = 20; h.used["claude-team"] = 10;
  await h.runtime.headroom.get(h.rows.find((row) => row.id === "claude-work")!);
  await h.runtime.headroom.get(h.rows.find((row) => row.id === "claude-team")!);
  await h.runtime.onTurnEnd(turnPayload(h, completed), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude-team");
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "headroom");
  assert.equal(h.calls.send.length, 0);
}));
test("a successful turn below the threshold does not move", async () => withHarness(async (h) => {
  h.agent.metadata[META_ACCOUNT] = "claude";
  h.used.claude = 40;
  await h.runtime.onTurnEnd(turnPayload(h, completed), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude");
  assert.equal(h.calls.timeline.length, 0);
}));

test("switchTo defers a running chat and applies the move after its turn ends", async () => withHarness(async (h) => {
  h.agent.status = "running";
  const result = await h.runtime.switchTo(h.paseo, h.agent.id, "claude-work");
  assert.equal(result.deferred, true);
  h.agent.status = "idle";
  await h.runtime.onTurnEnd(turnPayload(h, completed), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude-work");
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "manual");
}));
test("switchTo moves a chat that is still opening right away instead of waiting for a turn", async () => withHarness(async (h) => {
  h.agent.status = "initializing";
  setTimeout(() => { h.agent.status = "idle"; }, 20);
  const result = await h.runtime.switchTo(h.paseo, h.agent.id, "claude-work");
  assert.equal(result.deferred, false);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude-work");
  assert.equal(h.calls.reload, 1);
}));
test("switchTo doesn't report a move that didn't happen", async () => withHarness(async (h) => {
  h.agent.archivedAt = "2026-01-01T00:00:00Z";
  await assert.rejects(h.runtime.switchTo(h.paseo, h.agent.id, "claude-work"), /no longer exists/);
  assert.equal(h.calls.reload, 0);
}));
test("failover ignores an old 100 percent reading once the account's limit has reset", async () => withHarness(async (h) => {
  // An hour ago, Work and Team both read 100%.
  h.used["claude-work"] = 100;
  h.used["claude-team"] = 100;
  await h.runtime.headroom.get(h.rows.find((row) => row.id === "claude-work")!);
  await h.runtime.headroom.get(h.rows.find((row) => row.id === "claude-team")!);
  // Work's window has since reset; Team is still at its limit. Accounts are listed by id, so Team
  // comes first and wins a tie: only a fresh reading (not "unknown" for both) can pick Work.
  h.used["claude-work"] = 5;
  h.nowRef.value += 60 * 60_000;
  await h.runtime.onTurnEnd(turnPayload(h, failure("You've hit your limit · resets 3pm (UTC)")), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude-work");
  assert.equal(h.calls.timeline.at(-1)?.data.reason, "limit");
}));
// Paseo times plugin requests out at 30 s; with a 50 ms wait this must settle in a few seconds.
test("switchTo queues the move, inside Paseo's request limit, when a turn starts and outlasts the wait", { timeout: 5_000 }, async () => withHarness(async (h) => {
  // The chat is idle when asked, then a queued message starts a turn that keeps running.
  const refresh = h.handle.refresh.bind(h.handle);
  let refreshes = 0;
  h.handle.refresh = async () => { await refresh(); if (++refreshes === 2) h.agent.status = "running"; };
  const result = await h.runtime.switchTo(h.paseo, h.agent.id, "claude-work");
  assert.equal(result.deferred, true);
  assert.equal(h.calls.reload, 0);
  h.agent.status = "idle";
  await h.runtime.onTurnEnd(turnPayload(h, completed), h.paseo);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude-work");
}, { manualIdleWaitMs: 50 }));
test("switchTo rejects Codex account switches", async () => withHarness(async (h) => {
  h.agent.provider = "codex";
  await assert.rejects(h.runtime.switchTo(h.paseo, h.agent.id, "codex-work"), /Codex chats stay on the account/);
}));
test("switchTo rejects a signed-out Claude account", async () => withHarness(async (h) => {
  const signedOut = await createHarness({ signedOut: ["claude-work"] });
  try {
    await assert.rejects(signedOut.runtime.switchTo(signedOut.paseo, signedOut.agent.id, "claude-work"), /isn't signed in/);
  } finally { await signedOut.close(); }
}));
test("a reload failure rolls the account metadata back and rejects", async () => withHarness(async (h) => {
  h.agent.metadata[META_ACCOUNT] = "claude";
  h.failReload();
  await assert.rejects(h.runtime.switchTo(h.paseo, h.agent.id, "claude-work"), /Couldn't reopen the chat/);
  assert.equal(h.agent.metadata[META_ACCOUNT], "claude");
  assert.deepEqual(h.calls.metadata.slice(-2), [{ [META_ACCOUNT]: "claude-work" }, { [META_ACCOUNT]: "claude" }]);
}));
