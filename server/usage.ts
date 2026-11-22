/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { UsageAccount, UsageScope, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import { discover as claudeDiscover, fetchUsage as claudeFetch } from "./vendor/paseo-usage/claude/server/usage.js";
import { inputSchema as claudeInput } from "./vendor/paseo-usage/claude/shared/input.js";
import { discover as codexDiscover, fetchUsage as codexFetch } from "./vendor/paseo-usage/codex/server/usage.js";
import { inputSchema as codexInput } from "./vendor/paseo-usage/codex/shared/input.js";
import { KIND_INFO, type AccountKind } from "../shared/accounts";
import { accountsFromConfig, mapLimit, type Host } from "./accounts";

/**
 * Usage for every extra account on Paseo's Usage page.
 *
 * Paseo's built-in Claude and Codex usage sources show the default login globally, and a running
 * agent's own login in its session. They don't list other accounts globally, so this plugin
 * registers one source per kind that does. Each account is looked up and fetched by Paseo's own
 * code (server/vendor/paseo-usage, unmodified, Apache-2.0), pointed at that account's folder.
 */

type Env = Record<string, string | undefined>;

/** Where the daemon keeps config.json. The daemon passes PASEO_HOME to plugin processes. */
export function paseoConfigPath(env: Env, home: string): string {
  const raw = env.PASEO_HOME?.trim() || "~/.paseo";
  const dir = raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? join(home, raw.slice(2)) : resolve(raw);
  return join(dir, "config.json");
}

export async function readProviders(env: Env, home: string): Promise<Record<string, unknown> | undefined> {
  const config = JSON.parse(await readFile(paseoConfigPath(env, home), "utf8")) as { agents?: { providers?: Record<string, unknown> } };
  return config.agents?.providers;
}

interface UsageHost extends Pick<Host, "homedir" | "platform"> {
  env: Env;
  providers(): Promise<Record<string, unknown> | undefined>;
  discover: Record<AccountKind, (scope: UsageScope) => Promise<UsageAccount[]>>;
}

/** The environment a lookup for one account sees: the user's home plus that account's folder. */
function accountEnv(kind: AccountKind, folder: string, host: UsageHost): Record<string, string> {
  const env: Record<string, string> = { HOME: host.env.HOME || host.homedir, [KIND_INFO[kind].envVar]: folder };
  if (host.env.USERPROFILE) env.USERPROFILE = host.env.USERPROFILE;
  // Claude's macOS Keychain item is stored under the login name.
  if (host.env.USER) env.USER = host.env.USER;
  return env;
}

export async function discoverAccounts(kind: AccountKind, scope: UsageScope, host: UsageHost): Promise<UsageAccount[]> {
  // A running agent's own login is already reported by Paseo's built-in source for its session.
  if (scope.kind !== "global") return [];
  const rows = accountsFromConfig(await host.providers(), host).filter((row) => row.kind === kind && !row.isDefault);
  const found = await mapLimit(rows, 3, async (row) => {
    try {
      // A session scope looks at exactly one folder, so the default login and other
      // tools' stores (Pi, OMP, OpenCode) aren't listed again here.
      const accounts = await host.discover[kind]({ kind: "session", provider: kind, env: accountEnv(kind, row.home, host) });
      return accounts.map((account) => ({ ...account, label: account.label ? `${row.label} · ${account.label}` : row.label }));
    } catch {
      return [];
    }
  });
  return found.flat();
}

export function usageSources(host: UsageHost): UsageSourceRegistration[] {
  return [
    {
      id: "accounts-claude",
      label: "Claude accounts",
      icon: "server/vendor/paseo-usage/claude/icon.svg",
      input: claudeInput,
      discover: (scope) => discoverAccounts("claude", scope, host),
      fetch: (input) => claudeFetch(claudeInput.parse(input)),
    },
    {
      id: "accounts-codex",
      label: "Codex accounts",
      icon: "server/vendor/paseo-usage/codex/icon.svg",
      input: codexInput,
      discover: (scope) => discoverAccounts("codex", scope, host),
      fetch: (input) => codexFetch(codexInput.parse(input)),
    },
  ];
}

export function defaultUsageHost(): UsageHost {
  const env = process.env;
  return {
    env,
    homedir: homedir(),
    platform: process.platform,
    providers: () => readProviders(env, homedir()),
    discover: { claude: (scope) => claudeDiscover(scope), codex: (scope) => codexDiscover(scope) },
  };
}
