/// <reference types="node" />
import { KINDS, type AccountKind } from "../shared/accounts";
import { AUTO_ACCOUNT, META_ACCOUNT, META_AGENT, SWITCH_ROW_KIND, type AccountChoice, type SwitchingOptions, type SwitchRow } from "../shared/switching";
import { accountsFromConfig, type Host } from "./accounts";
import { detectLimit } from "./limits";
import { matchRule } from "./rules";

/**
 * The switching engine: which account a chat runs on, and moving it.
 *
 * A chat keeps its provider. For Claude, the account is only the login: Claude Code reads its login
 * from CLAUDE_SECURESTORAGE_CONFIG_DIR when that is set (the Keychain item hashed from that folder on
 * macOS, `<folder>/.credentials.json` elsewhere; an empty value means the default login), while
 * CLAUDE_CONFIG_DIR keeps deciding settings and transcripts. So a chat can change account and keep
 * its conversation, settings, MCP servers and history. Codex has no login-only switch, and encrypts a
 * conversation per ChatGPT account, so Codex chats pick their account when they're created.
 */

/** JSON as Paseo stores it in agent metadata. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Row = ReturnType<typeof accountsFromConfig>[number];
type Providers = Record<string, unknown> | undefined;

const SECURE_STORAGE_VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/** Which CLI a provider runs: a built-in one, or the one a custom provider extends. */
export function providerKind(provider: string, providers: Providers): AccountKind | null {
  const base = provider.split("/")[0]!;
  if ((KINDS as readonly string[]).includes(base)) return base as AccountKind;
  const extended = (providers?.[base] as { extends?: unknown } | undefined)?.extends;
  return typeof extended === "string" && (KINDS as readonly string[]).includes(extended) ? (extended as AccountKind) : null;
}

/** The account whose login a provider uses on its own: its own folder, or the default login. */
export function providerAccount(provider: string, rows: readonly Row[], providers: Providers): Row | null {
  const base = provider.split("/")[0]!;
  const own = rows.find((row) => row.id === base);
  if (own) return own;
  const kind = providerKind(base, providers);
  return kind ? rows.find((row) => row.kind === kind && row.isDefault) ?? null : null;
}

/** The value of CLAUDE_SECURESTORAGE_CONFIG_DIR that selects this account's login. */
export function claudeLoginDir(row: Pick<Row, "isDefault" | "defaultHome" | "home">): string {
  // The default login lives under an unhashed Keychain name (macOS) or ~/.claude (elsewhere); only an
  // empty value finds it. Pointing the variable at ~/.claude would look for a hashed item that doesn't exist.
  return row.isDefault && row.defaultHome ? "" : row.home;
}

export function metaString(metadata: Readonly<Record<string, JsonValue>> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** The account a chat runs on: the one the plugin chose for it, else its provider's own. */
export function currentAccount(agent: { provider: string; metadata?: Readonly<Record<string, JsonValue>> | null }, rows: readonly Row[], providers: Providers): Row | null {
  const chosen = metaString(agent.metadata, META_ACCOUNT);
  const kind = providerKind(agent.provider, providers);
  const row = chosen ? rows.find((item) => item.id === chosen && item.kind === kind) : undefined;
  return row ?? providerAccount(agent.provider, rows, providers);
}

/**
 * The env a session should open with, or null to leave it alone. Applied on every open (create,
 * resume, refresh, import, and history reads), so a chat stays on its account after a restart.
 */
export function sessionEnv(request: { provider: string; metadata: Readonly<Record<string, JsonValue>> }, rows: readonly Row[], providers: Providers): Record<string, string> | null {
  if (providerKind(request.provider, providers) !== "claude") return null;
  const chosen = metaString(request.metadata, META_ACCOUNT);
  if (!chosen) return null;
  const row = rows.find((item) => item.id === chosen && item.kind === "claude");
  // A removed account falls back to the provider's own login rather than failing to open.
  if (!row) return null;
  const own = providerAccount(request.provider, rows, providers);
  if (own?.id === row.id) return null;
  return { [SECURE_STORAGE_VAR]: claudeLoginDir(row) };
}

export interface Headroom {
  usedPct: number | null;
  summary?: string;
}

export interface Limited {
  until: number;
  model?: string;
}

/**
 * The best account to move to: signed in, shown in the picker, not at a limit, and with the most
 * headroom. Accounts whose usage is unknown rank after any with known headroom below 90%.
 */
export function pickAccount(candidates: readonly (Row & { state: AccountChoice["state"] })[], headroom: ReadonlyMap<string, Headroom>, limited: ReadonlyMap<string, Limited>, now: number, options: { exclude?: readonly string[]; maxUsedPct?: number } = {}): Row | null {
  const scored = candidates
    .filter((row) => row.state === "signed-in" && row.enabled && !options.exclude?.includes(row.id))
    .filter((row) => (limited.get(row.id)?.until ?? 0) <= now)
    .map((row) => ({ row, used: headroom.get(row.id)?.usedPct ?? 90 }))
    .filter(({ used }) => used < (options.maxUsedPct ?? 100));
  scored.sort((a, b) => a.used - b.used);
  return scored[0]?.row ?? null;
}

/** Account for a new chat, from (in order) an explicit choice, a folder rule, then the new-chat setting. */
export function accountForNewChat(input: { provider: string; cwd: string; metadata?: Record<string, JsonValue> }, rows: readonly Row[], providers: Providers, settings: SwitchingOptions, best: (kind: AccountKind) => Row | null, ctx: { homedir: string; platform: NodeJS.Platform }): { row: Row; why: SwitchRow["reason"] | "explicit" } | null {
  const kind = providerKind(input.provider, providers);
  if (!kind) return null;
  const chosen = metaString(input.metadata, META_ACCOUNT);
  if (chosen === AUTO_ACCOUNT) {
    const row = best(kind);
    return row ? { row, why: "headroom" } : null;
  }
  if (chosen) {
    const row = rows.find((item) => item.id === chosen && item.kind === kind);
    return row ? { row, why: "explicit" } : null;
  }
  // Picking an account's own provider ("Claude (Work)") is already an explicit choice.
  if (input.provider.split("/")[0] !== kind) return null;
  const rule = matchRule(settings.rules.filter((item) => rows.some((row) => row.id === item.accountId && row.kind === kind)), input.cwd, ctx);
  if (rule) return { row: rows.find((row) => row.id === rule.accountId)!, why: "rule" };
  if (settings.newChats === "most-headroom") {
    const row = best(kind);
    return row ? { row, why: "headroom" } : null;
  }
  return null;
}

/** Guards automatic moves: at most `max` per agent in `windowMs`, so two exhausted accounts can't ping-pong. */
export class SwitchGuard {
  private readonly history = new Map<string, number[]>();
  constructor(private readonly max = 4, private readonly windowMs = 10 * 60_000) {}
  allow(agentId: string, now: number): boolean {
    const recent = (this.history.get(agentId) ?? []).filter((at) => now - at < this.windowMs);
    this.history.set(agentId, recent);
    return recent.length < this.max;
  }
  record(agentId: string, now: number) {
    this.history.set(agentId, [...(this.history.get(agentId) ?? []), now]);
  }
}

/** Runs one task per key at a time; a second task for the same key waits for the first. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export const RESUME_PROMPT = "You were interrupted by a usage limit, which has now reset. Continue exactly where you left off.";
export const CONTINUE_PROMPT = "You were interrupted by a usage limit. That's been sorted out: this chat now runs on another account. Continue exactly where you left off.";

export function switchRow(from: Row | null, to: Row | null, reason: SwitchRow["reason"], detail?: string): { type: "plugin"; id: string; kind: string; version: number; data: SwitchRow } {
  return {
    type: "plugin",
    id: `account-switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: SWITCH_ROW_KIND,
    version: 1,
    data: { from: from?.label ?? null, to: to?.label ?? null, reason, ...(detail ? { detail } : {}) },
  };
}

/** Exposed for tests: whether a failed turn's message is a usage limit for this kind of chat. */
export function limitFromFailure(kind: AccountKind, message: string, now: Date): { until: number; model?: string } | null {
  const hit = detectLimit(kind, message, now);
  if (!hit) return null;
  // Without a reset time, try again in an hour; a fresh usage reading can clear it sooner.
  return { until: hit.resetsAt ?? now.getTime() + 60 * 60_000, ...(hit.model ? { model: hit.model } : {}) };
}

export type { Host };
export { META_AGENT };
