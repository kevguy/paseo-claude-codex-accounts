/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  KIND_INFO,
  KINDS,
  accountId,
  accountLabel,
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
}

type Entry = { extends?: unknown; label?: unknown; env?: unknown; enabled?: unknown; order?: unknown };

const MANAGED_ID = /^(claude|codex)-[a-z0-9][a-z0-9-]{0,30}$/;
const STATUS_TTL_MS = 60_000;
const STATUS_CONCURRENCY = 3;

function isKind(value: unknown): value is AccountKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** One row per account: the two built-in providers plus every entry that extends one with its own folder. */
export function accountsFromConfig(providers: Record<string, unknown> | undefined, host: Pick<Host, "homedir" | "platform">) {
  const rows: Array<Omit<Account, "status" | "signIn"> & { defaultHome: boolean }> = [];
  for (const kind of KINDS) {
    const override = (providers?.[kind] ?? {}) as Entry;
    const envHome = typeof (override.env as Record<string, unknown> | undefined)?.[KIND_INFO[kind].envVar] === "string"
      ? ((override.env as Record<string, string>)[KIND_INFO[kind].envVar])
      : undefined;
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

export function clearStatusCache() {
  cache.clear();
}

export async function listAccounts(host: Host, options: { refresh?: boolean; now?: number } = {}): Promise<Account[]> {
  const { config } = await host.config.get();
  const rows = accountsFromConfig(config.providers, host);
  const now = options.now ?? Date.now();
  const statuses = await mapLimit(rows, STATUS_CONCURRENCY, async (row) => {
    const key = `${row.kind}\0${row.home}`;
    const hit = cache.get(key);
    if (!options.refresh && hit && now - hit.at < STATUS_TTL_MS) return hit.status;
    const status = await readStatus(row.kind, row.home, row.defaultHome, host);
    cache.set(key, { at: now, status });
    return status;
  });
  return rows.map(({ defaultHome, ...row }, index) => ({ ...row, status: statuses[index]!, signIn: signInCommands(row.kind, defaultHome ? null : row.home) }));
}

export async function addAccount(host: Host, kind: AccountKind, name: string): Promise<Account> {
  const slug = slugify(name);
  if (!slug) throw new Error("Use a name with at least one letter or number");
  const id = accountId(kind, slug);
  const { config } = await host.config.get();
  if (config.providers?.[id] !== undefined) throw new Error(`There is already a provider called ${id}`);
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

export async function updateAccount(host: Host, id: string, change: { label?: string; enabled?: boolean }) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  if (change.label !== undefined && !row.managed) throw new Error("Only accounts added here can be renamed here");
  const patch: Record<string, unknown> = {};
  if (change.label !== undefined) patch.label = change.label;
  if (change.enabled !== undefined) patch.enabled = change.enabled;
  if (Object.keys(patch).length) await host.config.patch({ providers: { [id]: patch } });
  return { ok: true as const };
}

/** Removes the provider entry. The folder, and the login inside it, stays until the user deletes it. */
export async function removeAccount(host: Host, id: string) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  if (!row.managed) throw new Error("Only accounts added here can be removed here");
  await host.config.patch({ removeProviders: [id] });
  cache.delete(`${row.kind}\0${row.home}`);
  return { ok: true as const, home: row.home };
}

export async function signInArgv(host: Host, id: string) {
  const { config } = await host.config.get();
  const row = accountsFromConfig(config.providers, host).find((item) => item.id === id);
  if (!row) throw new Error("That account no longer exists");
  if (!row.defaultHome) await mkdir(row.home, { recursive: true });
  return { row, ...signInTerminalArgv(row.kind, row.defaultHome ? null : row.home, host.platform) };
}
