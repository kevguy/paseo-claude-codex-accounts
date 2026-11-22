/// <reference types="node" />
import type { UsageAccount, UsageReport, UsageScope } from "@getpaseo/plugin/server/usage";
import { KIND_INFO, type AccountKind } from "../shared/accounts";
import type { Headroom, Row } from "./switching";
import { discover as claudeDiscover, fetchUsage as claudeFetch } from "./vendor/paseo-usage/claude/server/usage.js";
import { inputSchema as claudeInput } from "./vendor/paseo-usage/claude/shared/input.js";
import { discover as codexDiscover, fetchUsage as codexFetch } from "./vendor/paseo-usage/codex/server/usage.js";
import { inputSchema as codexInput } from "./vendor/paseo-usage/codex/shared/input.js";

/**
 * How close each account is to a limit, read with Paseo's own usage code (the same numbers as the
 * Usage page). Readings are cached, and one account is never asked more often than every 90 seconds,
 * because the providers rate-limit their usage endpoints.
 */

type Env = Record<string, string | undefined>;

export interface HeadroomDeps {
  env: Env;
  homedir: string;
  discover: Record<AccountKind, (scope: UsageScope) => Promise<UsageAccount[]>>;
  fetch: Record<AccountKind, (input: unknown) => Promise<UsageReport>>;
  now(): number;
  /** Fixed readings by account id, used only by the README screenshot demo (PASEO_ACCOUNTS_DEMO_USAGE). */
  demo?: Record<string, Headroom>;
}

export const MIN_INTERVAL_MS = 90_000;

/** Highest share used across the summary limits, and a short label such as "5h 42% · wk 18%". */
export function summarize(report: UsageReport): Headroom {
  if (report.status !== "available") return { usedPct: null };
  const windows = report.windows.filter((window) => window.summary !== false && typeof window.usedPct === "number");
  const summaryWindows = windows.filter((window) => window.summary);
  const shown = summaryWindows.length ? summaryWindows : windows;
  if (!shown.length) return { usedPct: null };
  const usedPct = Math.max(...windows.map((window) => window.usedPct as number));
  return { usedPct, summary: shown.map((window) => `${window.shortLabel ?? window.label} ${Math.round(window.usedPct as number)}%`).join(" · ") };
}

/** The env a usage lookup for one account sees. The default account is looked up without the variable. */
export function lookupEnv(row: Pick<Row, "kind" | "home" | "defaultHome">, deps: Pick<HeadroomDeps, "env" | "homedir">): Record<string, string> {
  const env: Record<string, string> = { HOME: deps.env.HOME || deps.homedir };
  if (deps.env.USERPROFILE) env.USERPROFILE = deps.env.USERPROFILE;
  if (deps.env.USER) env.USER = deps.env.USER;
  if (!row.defaultHome) env[KIND_INFO[row.kind].envVar] = row.home;
  return env;
}

export class HeadroomCache {
  private readonly readings = new Map<string, { at: number; value: Headroom }>();
  private readonly inflight = new Map<string, Promise<Headroom>>();
  constructor(private readonly deps: HeadroomDeps) {}

  /** The last reading, without asking the provider. */
  peek(id: string): Headroom | undefined {
    return this.readings.get(id)?.value;
  }

  /** Readings no older than `maxAgeMs`; older ones are left out, so they count as unknown. */
  snapshot(maxAgeMs = Infinity): Map<string, Headroom> {
    const now = this.deps.now();
    return new Map([...this.readings].filter(([, reading]) => now - reading.at <= maxAgeMs).map(([id, reading]) => [id, reading.value]));
  }

  /** Refreshes readings older than `maxAgeMs`, waiting at most `waitMs` for slow usage endpoints. */
  async refresh(rows: readonly Row[], maxAgeMs: number, waitMs = 2500): Promise<void> {
    let stop = () => {};
    await Promise.race([
      Promise.allSettled(rows.map((row) => this.get(row, maxAgeMs))),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        stop = () => clearTimeout(timer);
      }),
    ]);
    stop();
  }

  /** A reading no older than `maxAgeMs` (never fresher than the 90-second floor). */
  async get(row: Row, maxAgeMs = 5 * 60_000): Promise<Headroom> {
    const cached = this.readings.get(row.id);
    const age = cached ? this.deps.now() - cached.at : Infinity;
    if (cached && age < Math.max(maxAgeMs, MIN_INTERVAL_MS)) return cached.value;
    const running = this.inflight.get(row.id);
    if (running) return running;
    const work = this.read(row).finally(() => this.inflight.delete(row.id));
    this.inflight.set(row.id, work);
    return work;
  }

  private async read(row: Row): Promise<Headroom> {
    const demo = this.deps.demo?.[row.id];
    if (demo) {
      this.readings.set(row.id, { at: this.deps.now(), value: demo });
      return demo;
    }
    let value: Headroom = { usedPct: null };
    try {
      const [account] = await this.deps.discover[row.kind]({ kind: "session", provider: row.kind, env: lookupEnv(row, this.deps) });
      if (account) value = summarize(await this.deps.fetch[row.kind](account.input));
    } catch {
      // A failed reading counts as unknown; it is retried after the floor interval.
    }
    this.readings.set(row.id, { at: this.deps.now(), value });
    return value;
  }
}

export function defaultHeadroomDeps(env: Env, homedir: string): HeadroomDeps {
  return {
    env,
    homedir,
    discover: { claude: (scope) => claudeDiscover(scope), codex: (scope) => codexDiscover(scope) },
    fetch: { claude: (input) => claudeFetch(claudeInput.parse(input)), codex: (input) => codexFetch(codexInput.parse(input)) },
    now: () => Date.now(),
    ...(demoUsage(env) ? { demo: demoUsage(env)! } : {}),
  };
}

/** The screenshot demo's made-up readings: {"claude-work": {"usedPct": 42, "summary": "5h 42% · wk 18%"}}. */
function demoUsage(env: Env): Record<string, Headroom> | undefined {
  if (!env.PASEO_ACCOUNTS_DEMO_USAGE) return undefined;
  try {
    return JSON.parse(env.PASEO_ACCOUNTS_DEMO_USAGE) as Record<string, Headroom>;
  } catch {
    return undefined;
  }
}
