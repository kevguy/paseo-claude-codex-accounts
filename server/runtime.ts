/// <reference types="node" />
import type { PluginHookContext, PluginHookPayload, PluginHookResult } from "@getpaseo/plugin/server";
import type { AccountKind } from "../shared/accounts";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { AUTO_ACCOUNT, DEFAULT_SETTINGS, LABEL_ACCOUNT, META_ACCOUNT, META_AGENT, type AccountChoice, type SwitchingOptions } from "../shared/switching";
import { accountsFromConfig, listAccounts, type Host } from "./accounts";
import { type JsonValue, CONTINUE_PROMPT, RESUME_PROMPT, KeyedLock, SwitchGuard, accountForNewChat, currentAccount, limitFromFailure, metaString, pickAccount, providerAccount, providerKind, sessionEnv, switchRow, type Limited, type Row } from "./switching";
import { HeadroomCache, type HeadroomDeps } from "./headroom";

type PaseoApi = PluginHookContext["paseo"];
type Providers = Record<string, unknown> | undefined;
type Agent = NonNullable<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["current"]>>;
/** Readings older than this count as unknown when choosing where a chat goes. */
const READING_MAX_AGE_MS = 10 * 60_000;
type Ranked = Row & { state: AccountChoice["state"]; email?: string; detail?: string };

export interface RuntimeDeps {
  host(paseo: PaseoApi): Host;
  settings(): Promise<SwitchingOptions>;
  headroom: HeadroomDeps;
  now(): number;
  /** Logs problems that a user can't act on. Never pass tokens or file contents. */
  log(message: string): void;
}

/** Moves happen between turns. This waits briefly for a turn that is just finishing. */
async function waitUntilIdle(handle: ReturnType<PaseoApi["agents"]["ref"]>, timeoutMs = 30_000): Promise<Agent | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await handle.refresh();
    const agent = handle.current();
    if (!agent || agent.archivedAt) return null;
    if (agent.status !== "running" && agent.status !== "initializing") return agent;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export class AccountsRuntime {
  readonly headroom: HeadroomCache;
  readonly limited = new Map<string, Limited>();
  private readonly guard = new SwitchGuard();
  private readonly lock = new KeyedLock();
  /** Manual moves asked for while a turn was running; applied when it ends. */
  private readonly pending = new Map<string, string>();
  /** When each agent's latest turn started, to tell whether the user moved on after a limit. */
  private readonly turnStarted = new Map<string, number>();
  /** "Carry on after the reset" timers, per agent. */
  private readonly waits = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: RuntimeDeps) {
    this.headroom = new HeadroomCache(deps.headroom);
  }

  private async snapshot(paseo: PaseoApi, withStatus = true) {
    const host = this.deps.host(paseo);
    const { config } = await host.config.get();
    const providers: Providers = config.providers;
    const rows = accountsFromConfig(providers, host);
    const accounts = withStatus ? await listAccounts(host) : [];
    const byId = new Map(accounts.map((account) => [account.id, account.status]));
    const ranked: Ranked[] = rows.map((row) => {
      const status = byId.get(row.id);
      const detail = [status?.organization, status?.plan].filter(Boolean).join(" · ");
      return { ...row, state: status?.state ?? "unknown", ...(status?.email ? { email: status.email } : {}), ...(detail ? { detail } : {}) };
    });
    return { host, providers, rows, ranked };
  }

  /**
   * The best account to move to. Rankings use only recent readings (an old 100% must not rule out
   * an account whose limit has since reset), so call `freshen` first.
   */
  private best(ranked: readonly Ranked[], kind: AccountKind, options: { exclude?: string[]; maxUsedPct?: number } = {}) {
    return pickAccount(ranked.filter((row) => row.kind === kind), this.headroom.snapshot(READING_MAX_AGE_MS), this.limited, this.deps.now(), options);
  }

  /** Re-reads the usage of the accounts a pick could choose, without waiting long on slow endpoints. */
  private async freshen(ranked: readonly Ranked[], kind?: AccountKind) {
    const candidates = ranked.filter((row) => (!kind || row.kind === kind) && row.enabled && row.state === "signed-in");
    await this.headroom.refresh(candidates, READING_MAX_AGE_MS);
  }

  // ---- Hooks ----

  async onCreate({ request }: PluginHookPayload<"agent.create.before">, paseo: PaseoApi): Promise<PluginHookResult<"agent.create.before">> {
    const settings = await this.deps.settings();
    const snap = await this.snapshot(paseo);
    const metadata: Record<string, JsonValue> = { ...(request.metadata ?? {}) };
    if (metaString(metadata, META_ACCOUNT) === AUTO_ACCOUNT || settings.newChats === "most-headroom") await this.freshen(snap.ranked);
    const choice = accountForNewChat(
      { provider: request.config.provider, cwd: request.config.cwd, metadata },
      snap.rows,
      snap.providers,
      settings,
      (kind) => this.best(snap.ranked, kind),
      snap.host,
    );
    if (!choice) {
      // "Most headroom" with nothing usable: open on the picker's provider, without a stale "auto".
      if (metaString(metadata, META_ACCOUNT) === AUTO_ACCOUNT) {
        delete metadata[META_ACCOUNT];
        return { ...request, metadata };
      }
      return;
    }
    metadata[META_ACCOUNT] = choice.row.id;
    let config = request.config;
    // Codex has no login-only switch, so a Codex chat runs on its account's own provider.
    if (choice.row.kind === "codex" && providerAccount(config.provider, snap.rows, snap.providers)?.id !== choice.row.id) {
      config = { ...config, provider: choice.row.id };
    }
    return { ...request, config, metadata };
  }

  async onOpen({ request }: PluginHookPayload<"agent.open.before">, paseo: PaseoApi): Promise<PluginHookResult<"agent.open.before">> {
    if (request.purpose === "interactive" && metaString(request.metadata, META_AGENT) !== request.agentId) {
      // The message box doesn't know its agent's id, so record it on the agent. Not awaited:
      // writing to the agent whose session is opening, from inside this hook, would deadlock.
      const agentId = request.agentId;
      setTimeout(() => void paseo.agents.ref(agentId).setMetadata({ [META_AGENT]: agentId }).catch(() => undefined), 50);
    }
    // Paseo fails the open when a hook throws, so a config read that fails must not block every chat.
    let snap: Awaited<ReturnType<AccountsRuntime["snapshot"]>>;
    try {
      snap = await this.snapshot(paseo, false);
    } catch (error) {
      this.deps.log(`Accounts plugin couldn't read accounts while opening a chat: ${(error as Error).message}`);
      return;
    }
    let metadata = request.metadata;
    // A label names the account to start on (scripts, orchestrators, `paseo import`). It applies when
    // the chat first opens; after that the chat's own choice, which later switches update, wins.
    const labelled = request.labels[LABEL_ACCOUNT];
    if ((request.reason === "create" || request.reason === "import") && labelled && metaString(metadata, META_ACCOUNT) !== labelled) {
      const row = snap.rows.find((item) => item.id === labelled);
      // Only Claude chats change login in place. A Codex chat's account is its provider, which
      // can't change once the chat exists, so a Codex label is reported rather than recorded.
      if (row && row.kind === "claude" && providerKind(request.provider, snap.providers) === "claude") {
        metadata = { ...metadata, [META_ACCOUNT]: labelled };
        const agentId = request.agentId;
        setTimeout(() => void paseo.agents.ref(agentId).setMetadata({ [META_ACCOUNT]: labelled }).catch(() => undefined), 50);
      } else {
        this.deps.log(`Accounts plugin: label ${LABEL_ACCOUNT}=${labelled} doesn't name a Claude account this chat can use. For Codex, start the chat with --provider ${labelled}.`);
      }
    }
    const env = sessionEnv({ provider: request.provider, metadata }, snap.rows, snap.providers);
    const settings = await this.deps.settings();
    const tools = settings.agentTools && request.purpose === "interactive" ? [...request.tools, ...this.tools(paseo)] : null;
    if (!env && !tools) return;
    return { ...request, ...(env ? { env: { ...request.env, ...env } } : {}), ...(tools ? { tools } : {}) };
  }

  /** Tools for orchestrating agents: see the accounts, and move this chat or another one. */
  private tools(paseo: PaseoApi) {
    return [
      defineAgentTool({
        name: "accounts_list",
        title: "List accounts",
        description: "Lists the Claude or Codex accounts this chat (or another agent) can run on, which one it uses now, and how close each is to its usage limits.",
        input: z.object({ agentId: z.string().optional().describe("Another agent's id; defaults to this chat") }),
        execute: async ({ agentId }, { agent }) => {
          const result = await this.chooser(paseo, { agentId: agentId ?? agent.id });
          return { text: JSON.stringify(result, null, 1), structuredContent: result };
        },
      }),
      defineAgentTool({
        name: "accounts_switch",
        title: "Switch account",
        description: "Moves a Claude chat to another account, keeping its conversation. Moving this chat takes effect when the current turn ends. Codex chats can't move.",
        input: z.object({ accountId: z.string().describe("An id from accounts_list"), agentId: z.string().optional().describe("Another agent's id; defaults to this chat") }),
        execute: async ({ accountId, agentId }, { agent }) => {
          try {
            const result = await this.switchTo(paseo, agentId ?? agent.id, accountId);
            return { text: result.deferred ? `Moves to ${result.label} when the current turn ends.` : `Now on ${result.label}.` };
          } catch (error) {
            return { text: (error as Error).message, isError: true };
          }
        },
      }),
    ];
  }

  onTurnStart({ agent }: PluginHookPayload<"agent.turn.before">) {
    this.turnStarted.set(agent.id, this.deps.now());
    // Someone picked the chat back up, so a pending "carry on after the reset" no longer applies.
    const wait = this.waits.get(agent.id);
    if (wait) {
      clearTimeout(wait);
      this.waits.delete(agent.id);
    }
  }

  async onTurnEnd({ agent, outcome }: PluginHookPayload<"agent.turn.after">, paseo: PaseoApi): Promise<void> {
    try {
      const pending = this.pending.get(agent.id);
      if (pending) {
        this.pending.delete(agent.id);
        const snap = await this.snapshot(paseo);
        const target = snap.rows.find((row) => row.id === pending);
        if (target) await this.move(paseo, agent.id, target, "manual");
        return;
      }
      if (outcome.kind === "failed") await this.afterFailure(paseo, agent, outcome.error.message);
      else if (outcome.kind === "completed") await this.afterSuccess(paseo, agent);
    } catch (error) {
      this.deps.log(`Accounts plugin couldn't finish handling a turn: ${(error as Error).message}`);
    }
  }

  private async afterFailure(paseo: PaseoApi, agent: { id: string; provider: string; metadata: Record<string, JsonValue> }, message: string) {
    const failedAt = this.deps.now();
    const snap = await this.snapshot(paseo);
    const kind = providerKind(agent.provider, snap.providers);
    if (!kind) return;
    const from = currentAccount(agent, snap.rows, snap.providers);
    if (!from) return;
    // Two independent signals, so a reworded CLI message doesn't silently stop failover: the
    // message itself, or else the account's usage reading showing a limit used up.
    let limit = limitFromFailure(kind, message, new Date(failedAt));
    if (!limit) {
      const reading = await this.headroom.get(from, 0);
      if (reading.usedPct === null || reading.usedPct < 100) return;
      limit = { until: failedAt + 60 * 60_000 };
    }
    this.limited.set(from.id, limit);
    const settings = await this.deps.settings();
    const handle = paseo.agents.ref(agent.id);
    const resets = new Date(limit.until).toISOString();
    await this.freshen(snap.ranked, kind);
    if (kind === "codex") {
      const other = this.best(snap.ranked, "codex", { exclude: [from.id] });
      if (!other && settings.waitForReset) return this.waitForReset(paseo, agent.id, from, limit.until, failedAt);
      await this.note(handle, switchRow(from, null, "stuck", other ? `Codex chats stay on their account. Start a new chat on ${other.label} to keep going.` : `Every Codex account is at a limit. ${from.label} resets ${resets}.`));
      return;
    }
    if (!settings.autoSwitch) {
      await this.note(handle, switchRow(from, null, "stuck", "Automatic switching is off. Choose another account from the message box."));
      return;
    }
    if (!this.guard.allow(agent.id, failedAt)) {
      await this.note(handle, switchRow(from, null, "stuck", "This chat already switched accounts several times in the last 10 minutes, so it stopped switching automatically to avoid a loop."));
      return;
    }
    const target = this.best(snap.ranked, "claude", { exclude: [from.id] });
    if (!target) {
      const claudeIds = new Set(snap.rows.filter((row) => row.kind === "claude").map((row) => row.id));
      const soonest = [...this.limited].filter(([id]) => claudeIds.has(id)).reduce((min, [, item]) => Math.min(min, item.until), limit.until);
      if (settings.waitForReset) return this.waitForReset(paseo, agent.id, from, soonest, failedAt);
      await this.note(handle, switchRow(from, null, "stuck", `Every Claude account is at a limit. The first resets ${new Date(soonest).toISOString()}.`));
      return;
    }
    const moved = await this.move(paseo, agent.id, target, "limit", `${from.label} hit its limit`);
    if (!moved || !settings.continueAfterSwitch) return;
    // Only carry on if nobody has used the chat since the limit.
    if ((this.turnStarted.get(agent.id) ?? 0) > failedAt) return;
    await handle.send(CONTINUE_PROMPT).catch((error) => this.deps.log(`Accounts plugin couldn't resume a chat: ${(error as Error).message}`));
  }

  private async afterSuccess(paseo: PaseoApi, agent: { id: string; provider: string; metadata: Record<string, JsonValue> }) {
    const snap = await this.snapshot(paseo);
    const from = currentAccount(agent, snap.rows, snap.providers);
    if (!from) return;
    // A turn that worked shows the account isn't at a limit any more.
    this.limited.delete(from.id);
    const settings = await this.deps.settings();
    if (!settings.autoSwitch || settings.switchBeforePercent >= 100) return;
    if (providerKind(agent.provider, snap.providers) !== "claude") return;
    const reading = await this.headroom.get(from);
    if (reading.usedPct === null || reading.usedPct < settings.switchBeforePercent) return;
    const now = this.deps.now();
    if (!this.guard.allow(agent.id, now)) return;
    await this.freshen(snap.ranked, "claude");
    // Only move to an account with real room, so two busy accounts don't trade the chat back and forth.
    const target = this.best(snap.ranked, "claude", { exclude: [from.id], maxUsedPct: settings.switchBeforePercent - 10 });
    if (!target) return;
    await this.move(paseo, agent.id, target, "headroom", `${from.label} is at ${Math.round(reading.usedPct)}%`);
  }

  /**
   * Every account is at a limit: carry on once the first resets. Opt-in, bounded to 8 days, and
   * cancelled as soon as anyone starts a turn in the chat. The wait lives in the plugin process, so a
   * restart forgets it (the note in the chat says when it would have resumed).
   */
  private async waitForReset(paseo: PaseoApi, agentId: string, from: Row, until: number, failedAt: number) {
    const handle = paseo.agents.ref(agentId);
    const delay = Math.min(Math.max(until - this.deps.now(), 0) + 60_000, 8 * 24 * 60 * 60_000);
    const at = new Date(this.deps.now() + delay);
    clearTimeout(this.waits.get(agentId));
    const timer = setTimeout(() => {
      this.waits.delete(agentId);
      void (async () => {
        if ((this.turnStarted.get(agentId) ?? 0) > failedAt) return;
        const snap = await this.snapshot(paseo);
        this.limited.delete(from.id);
        let moved = false;
        if (from.kind === "claude") {
          await this.freshen(snap.ranked, "claude");
          const target = this.best(snap.ranked, "claude");
          if (target && target.id !== from.id && (await this.move(paseo, agentId, target, "limit", "A limit reset"))) moved = true;
        }
        if ((this.turnStarted.get(agentId) ?? 0) > failedAt) return;
        await handle.send(moved ? CONTINUE_PROMPT : RESUME_PROMPT);
      })().catch((error) => this.deps.log(`Accounts plugin couldn't resume a chat after a reset: ${(error as Error).message}`));
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.waits.set(agentId, timer);
    await this.note(handle, switchRow(from, null, "stuck", `Every ${from.kind === "claude" ? "Claude" : "Codex"} account is at a limit. This chat will carry on at ${at.toISOString()}, unless you write to this chat first.`));
  }

  /** Moves a Claude chat to another login and reopens it. Returns whether it moved. */
  async move(paseo: PaseoApi, agentId: string, target: Row, reason: "manual" | "limit" | "headroom", detail?: string): Promise<boolean> {
    return this.lock.run(agentId, async () => {
      const handle = paseo.agents.ref(agentId);
      // Read the accounts first, so nothing slow sits between "the chat is idle" and the reopen.
      const snap = await this.snapshot(paseo, false);
      const agent = await waitUntilIdle(handle);
      if (!agent) return false;
      const from = currentAccount(agent, snap.rows, snap.providers);
      if (from?.id === target.id) return false;
      await handle.setMetadata({ [META_ACCOUNT]: target.id });
      try {
        await handle.reload();
      } catch (error) {
        // Put the chat back on its account rather than leave it half-moved.
        await handle.setMetadata({ [META_ACCOUNT]: from?.id ?? null }).catch(() => undefined);
        throw new Error(`Couldn't reopen the chat on ${target.label}: ${(error as Error).message}`);
      }
      if (reason !== "manual") this.guard.record(agentId, this.deps.now());
      await this.note(handle, switchRow(from, target, reason, detail));
      return true;
    });
  }

  /** Adds the plugin's note to a chat. A note that can't be added is logged, never fatal. */
  private async note(handle: ReturnType<PaseoApi["agents"]["ref"]>, row: ReturnType<typeof switchRow>) {
    try {
      await handle.timeline.append(row);
    } catch (error) {
      this.deps.log(`Accounts plugin couldn't add a note to a chat: ${(error as Error).message}`);
    }
  }

  // ---- RPCs ----

  async chooser(paseo: PaseoApi, input: { agentId?: string; provider?: string }) {
    const snap = await this.snapshot(paseo);
    let provider = input.provider ?? null;
    let current: Row | null = null;
    if (input.agentId) {
      const handle = paseo.agents.ref(input.agentId);
      await handle.refresh();
      const agent = handle.current();
      if (agent) {
        provider = agent.provider;
        current = currentAccount(agent, snap.rows, snap.providers);
        const pending = this.pending.get(input.agentId);
        if (pending) current = snap.rows.find((row) => row.id === pending) ?? current;
      }
    }
    const kind = provider ? providerKind(provider, snap.providers) : null;
    // Hidden accounts stay out of the menu, like the model picker, unless the chat is on one.
    const rows = snap.ranked.filter((row) => row.kind === kind && (row.enabled || row.id === current?.id));
    // Fresh readings for the menu, but don't keep it waiting on a slow usage endpoint.
    await Promise.race([Promise.allSettled(rows.map((row) => this.headroom.get(row))), new Promise((resolve) => setTimeout(resolve, 2500))]);
    const now = this.deps.now();
    const choices: AccountChoice[] = rows.map((row) => {
      const reading = this.headroom.peek(row.id);
      const until = this.limited.get(row.id)?.until;
      return {
        id: row.id,
        label: row.label,
        ...(row.email ? { email: row.email } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
        state: row.state,
        usedPct: reading?.usedPct ?? null,
        ...(reading?.summary ? { usage: reading.summary } : {}),
        ...(until && until > now ? { limitedUntil: new Date(until).toISOString() } : {}),
      };
    });
    return { kind, current: current?.id ?? null, choices, inPlace: kind === "claude" };
  }

  dispose() {
    for (const timer of this.waits.values()) clearTimeout(timer);
    this.waits.clear();
  }

  async switchTo(paseo: PaseoApi, agentId: string, accountId: string) {
    const snap = await this.snapshot(paseo);
    const handle = paseo.agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current();
    if (!agent) throw new Error("That chat no longer exists");
    const kind = providerKind(agent.provider, snap.providers);
    const target = snap.ranked.find((row) => row.id === accountId);
    if (!target || target.kind !== kind) throw new Error("That account can't run this chat");
    if (kind === "codex") throw new Error(`Codex chats stay on the account they started on, because Codex encrypts each conversation for its account. Start a new chat on ${target.label}.`);
    if (target.state === "signed-out") throw new Error(`${target.label} isn't signed in. Sign in from Settings → Plugins → Claude & Codex Accounts first.`);
    // Only a running turn defers the move; a chat that is still opening is waited for by move().
    if (agent.status === "running") {
      this.pending.set(agentId, target.id);
      return { ok: true as const, label: target.label, deferred: true };
    }
    this.pending.delete(agentId);
    if (await this.move(paseo, agentId, target, "manual")) return { ok: true as const, label: target.label, deferred: false };
    // It didn't move: already there, gone, or a turn started and outlasted the wait.
    await handle.refresh();
    const now = handle.current();
    if (!now || now.archivedAt) throw new Error("That chat no longer exists");
    if (currentAccount(now, snap.rows, snap.providers)?.id === target.id) return { ok: true as const, label: target.label, deferred: false };
    if (now.status === "running") {
      this.pending.set(agentId, target.id);
      return { ok: true as const, label: target.label, deferred: true };
    }
    throw new Error(`Couldn't move the chat to ${target.label}. Try again.`);
  }
}

export { DEFAULT_SETTINGS };
