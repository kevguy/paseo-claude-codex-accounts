/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  KIND_INFO,
  KINDS,
  accountId,
  accountLabel,
  displayPath,
  signInCommands,
  signInTerminalArgv,
  slugify,
  type Account,
  type AccountKind,
  type AccountStatus,
} from "../shared/accounts";
import { readStatus, type StatusEnv } from "./status";

/** The slice of Paseo's daemon config API this plugin uses (`paseo.config` in a handler). */
export interface ConfigApi {
  get(): Promise<{ config: { providers?: Record<string, unknown> } }>;
  patch(patch: { providers?: Record<string, Record<string, unknown>>; removeProviders?: string[] }): Promise<unknown>;
}

export interface Host extends StatusEnv {
  config: ConfigApi;
  /** The daemon's environment. A CLAUDE_CONFIG_DIR or CODEX_HOME here moves the default account. */
  env?: Record<string, string | undefined>;
}

type Entry = { extends?: unknown; label?: unknown; env?: unknown; enabled?: unknown; order?: unknown };

const MANAGED_ID = /^(claude|codex)-[a-z0-9][a-z0-9-]{0,30}$/;
const STATUS_TTL_MS = 60_000;
const STATUS_CONCURRENCY = 3;

function isKind(value: unknown): value is AccountKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** One row per account: the two built-in providers plus every entry that extends one with its own folder. */
export function accountsFromConfig(providers: Record<string, unknown> | undefined, host: Pick<Host, "homedir" | "platform" | "env">) {
  const rows: Array<Omit<Account, "status" | "signIn" | "displayHome"> & { defaultHome: boolean }> = [];
  for (const kind of KINDS) {
    const override = (providers?.[kind] ?? {}) as Entry;
    const { envVar } = KIND_INFO[kind];
    const configured = (override.env as Record<string, unknown> | undefined)?.[envVar];
    // The built-in provider uses its own env entry first, then whatever the daemon inherited.
    const envHome = (typeof configured === "string" && configured) || host.env?.[envVar] || undefined;
    rows.push({
      id: kind,
      kind,
      label: typeof override.label === "string" ? override.label : KIND_INFO[kind].label,
      home: envHome ?? join(host.homedir, KIND_INFO[kind].defaultFolder),
      defaultHome: envHome === undefined,
      isDefault: true,
      managed: false,
      enabled: override.enabled !== false,
      ...(typeof override.order === "number" ? { order: override.order } : {}),
    });
  }
  for (const [id, raw] of Object.entries(providers ?? {})) {
    const entry = (raw ?? {}) as Entry;
    if (!isKind(entry.extends) || isKind(id)) continue;
    const kind = entry.extends;
    const home = (entry.env as Record<string, unknown> | undefined)?.[KIND_INFO[kind].envVar];
    // An entry without its own folder shares the default login (a proxy or model override), so it isn't an account.
    if (typeof home !== "string" || !home) continue;
    rows.push({
      id,
      kind,
      label: typeof entry.label === "string" ? entry.label : id,
      home,
      defaultHome: false,
      isDefault: false,
      managed: MANAGED_ID.test(id) && id.startsWith(`${kind}-`),
      enabled: entry.enabled !== false,
      ...(typeof entry.order === "number" ? { order: entry.order } : {}),
    });
  }
  return rows.sort((a, b) =>
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    Number(b.isDefault) - Number(a.isDefault) ||
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
    a.label.localeCompare(b.label));
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const cache = new Map<string, { at: number; status: AccountStatus }>();

/** The default Claude folder reads a different identity file and Keychain item, so it gets its own key. */
function cacheKey(row: { kind: AccountKind; home: string; defaultHome: boolean }) {
  return `${row.kind}\0${row.defaultHome ? "default" : "custom"}\0${row.home}`;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs config changes one at a time, so two quick adds can't both pass the duplicate check. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}

export function clearStatusCache() {
  cache.clear();
}

export async function listAccounts(host: Host, options: { refresh?: boolean; now?: number } = {}): Promise<Account[]> {
  const { config } = await host.config.get();
  const rows = accountsFromConfig(config.providers, host);
  const now = options.now ?? Date.now();
  const statuses = await mapLimit(rows, STATUS_CONCURRENCY, async (row) => {
    const key = cacheKey(row);
    const hit = cache.get(key);
    if (!options.refresh && hit && now - hit.at < STATUS_TTL_MS) return hit.status;
    const status = await readStatus(row.kind, row.home, row.defaultHome, host);
    cache.set(key, { at: options.now ?? Date.now(), status });
    return status;
  });
  return rows.map(({ defaultHome, ...row }, index) => ({ ...row, displayHome: displayPath(row.home, host.homedir, host.platform), status: statuses[index]!, signIn: signInCommands(row.kind, defaultHome ? null : row.home, host) }));
}

export function addAccount(host: Host, kind: AccountKind, name: string): Promise<Account> {
  return serial(() => addAccountNow(host, kind, name));
}

async function addAccountNow(host: Host, kind: AccountKind, name: string): Promise<Account> {
  const slug = slugify(name);
  if (!slug) throw new Error("Use a name with at least one letter or number");
  const id = accountId(kind, slug);
  const { config } = await host.config.get();
  if (config.providers?.[id] !== undefined) throw new Error(`"${name.trim()}" becomes the provider id ${id}, which already exists. Choose a different name.`);
  const label = accountLabel(kind, name);
  const existing = accountsFromConfig(config.providers, host);
  if (existing.some((row) => row.label.toLowerCase() === label.toLowerCase())) throw new Error(`There is already an account called ${label}`);
  const home = join(host.homedir, `${KIND_INFO[kind].folderPrefix}${slug}`);
  // Codex refuses to start when CODEX_HOME doesn't exist; an existing folder (and its login) is reused.
  await mkdir(home, { recursive: true });
  await host.config.patch({ providers: { [id]: { extends: kind, label, env: { [KIND_INFO[kind].envVar]: home } } } });
  const created = (await listAccounts(host, { refresh: true })).find((row) => row.id === id);
  if (!created) throw new Error("Paseo didn't keep the new account; check the daemon log");
  return created;
}

export function updateAccount(host: Host, id: string, change: { label?: string; enabled?: boolean }) {
  return serial(() => updateAccountNow(host, id, change));
}

async function updateAccountNow(host: Host, id: string, change: { label?: string; enabled?: boolean }) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  const label = change.label?.trim();
  if (label !== undefined) {
    if (!row.managed) throw new Error("Only accounts added here can be renamed here");
    if (!label) throw new Error("An account needs a name");
    const others = accountsFromConfig(config.providers, host).filter((item) => item.id !== id);
    if (others.some((item) => item.label.toLowerCase() === label.toLowerCase())) throw new Error(`There is already an account called ${label}`);
  }
  const patch: Record<string, unknown> = {};
  if (label !== undefined) patch.label = label;
  if (change.enabled !== undefined) patch.enabled = change.enabled;
  if (Object.keys(patch).length) await host.config.patch({ providers: { [id]: patch } });
  return { ok: true as const };
}

/** Removes the provider entry. The folder, and the login inside it, stays until the user deletes it. */
export function removeAccount(host: Host, id: string) {
  return serial(() => removeAccountNow(host, id));
}

async function removeAccountNow(host: Host, id: string) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  if (!row.managed) throw new Error("Only accounts added here can be removed here");
  await host.config.patch({ removeProviders: [id] });
  cache.delete(cacheKey(row));
  return { ok: true as const, home: row.home };
}

export async function signInArgv(host: Host, id: string) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  if (!row.defaultHome && !isAbsolute(row.home)) throw new Error(`${row.label} uses the folder "${row.home}", which isn't a full path. Fix it in Paseo's config.`);
  if (!row.defaultHome) await mkdir(row.home, { recursive: true });
  return { row, ...signInTerminalArgv(row.kind, row.defaultHome ? null : row.home, host.platform) };
}
