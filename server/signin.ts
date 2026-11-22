/// <reference types="node" />
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { delimiter, dirname, join, posix, win32 } from "node:path";
import type { AccountKind } from "../shared/accounts";
import { startClaudeLogin, type ClaudeLoginSession } from "./claude-login";
import { startCodexLogin, type CodexLoginMethod, type CodexLoginSession } from "./codex-login";

/**
 * Signing an account in from inside Paseo, on any device. Claude: the CLI's own sign-in, where the
 * page shows a code to paste back (works from a phone), or on the host computer a page that finishes
 * by itself. Codex: the app-server's browser sign-in (host computer) or a device code (any device).
 * Sessions live in the plugin process; at most one per account, and each expires.
 */

type Env = Record<string, string | undefined>;
const EXPIRY_MS = 15 * 60_000;

/** Finds a CLI on PATH the way a shell would, including Windows' .exe/.cmd shims. */
export async function resolveCommand(name: string, env: Env, platform: NodeJS.Platform, exists: (path: string) => Promise<boolean> = isExecutable): Promise<string | null> {
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(name)) return (await exists(name)) ? name : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())] : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      // On Windows a bare name without extension is only runnable if it has one, so skip "".
      if (platform === "win32" && !ext) continue;
      const candidate = paths.join(dir, `${name}${ext}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command Paseo runs for a provider: its configured `command`, else the CLI's name. */
export function configuredCommand(kind: AccountKind, providers: Record<string, unknown> | undefined): string[] {
  const command = (providers?.[kind] as { command?: unknown } | undefined)?.command;
  if (Array.isArray(command) && command.length && command.every((part) => typeof part === "string" && part)) return command as string[];
  if (typeof command === "string" && command.trim()) return [command.trim()];
  return [kind];
}

export type SignInView =
  | { state: "waiting"; kind: AccountKind; url: string; localUrl?: string; code?: string; needsCode: boolean }
  | { state: "done"; email?: string; warning?: string }
  | { state: "failed"; error: string };

interface Entry {
  id: string;
  accountId: string;
  kind: AccountKind;
  claude?: ClaudeLoginSession;
  codex?: CodexLoginSession;
  view: SignInView;
  expires: ReturnType<typeof setTimeout>;
}

export interface SignInDeps {
  env: Env;
  platform: NodeJS.Platform;
  homedir: string;
  /** Folder for Claude's browser-capture script, inside the Paseo home. */
  shimDir: string;
  onSignedIn(accountId: string): void;
}

export class SignIns {
  private readonly sessions = new Map<string, Entry>();
  constructor(private readonly deps: SignInDeps) {}

  async start(input: { accountId: string; kind: AccountKind; home: string | null; method: CodexLoginMethod; providers: Record<string, unknown> | undefined; email?: string; label?: string; identity?: () => Promise<string | undefined> }): Promise<{ sessionId: string; view: SignInView }> {
    // Who this folder signs in as now, to warn if a new sign-in swaps the person behind its chats.
    const before = await input.identity?.().catch(() => undefined);
    // A new attempt replaces an older one for the same account.
    for (const entry of this.sessions.values()) if (entry.accountId === input.accountId) await this.cancel(entry.id);
    const [name, ...prefix] = configuredCommand(input.kind, input.providers);
    const resolved = await resolveCommand(name!, this.deps.env, this.deps.platform);
    if (!resolved) throw new Error(`Couldn't find the ${input.kind} command on this computer. Install it, or sign in from a terminal.`);
    // A Windows .cmd shim needs a shell; the arguments the login modules pass are fixed, never user text.
    const command = [resolved, ...prefix];
    const env = { ...this.deps.env, PATH: [dirname(resolved), this.deps.env.PATH ?? ""].filter(Boolean).join(delimiter) };
    const id = randomUUID();
    let entry: Entry;
    if (input.kind === "claude") {
      const session = await startClaudeLogin(input.home, { spawn, command, platform: this.deps.platform, env, shimDir: this.deps.shimDir, ...(input.email ? { email: input.email } : {}) });
      entry = this.track(id, input, { claude: session, view: { state: "waiting", kind: "claude", url: session.start.url, ...(session.start.localUrl ? { localUrl: session.start.localUrl } : {}), needsCode: true } });
      void session.done.then(async (result) => this.finish(id, result.ok ? await this.checked(before, input) : { state: "failed", error: result.error }));
    } else {
      const session = await startCodexLogin(input.home ?? join(this.deps.homedir, ".codex"), input.method, { spawn, command: command as [string, ...string[]], platform: this.deps.platform, env });
      entry = this.track(id, input, { codex: session, view: { state: "waiting", kind: "codex", url: session.start.url, ...(session.start.method === "device-code" ? { code: session.start.code } : {}), needsCode: false } });
      void session.done.then(async (result) => this.finish(id, result.ok ? await this.checked(before, input, result.email) : { state: "failed", error: result.error }));
    }
    return { sessionId: id, view: this.view(entry.id) };
  }

  /** The finished view, with a warning when the folder now holds someone else's login. */
  private async checked(before: string | undefined, input: { label?: string; identity?: () => Promise<string | undefined> }, reported?: string): Promise<SignInView> {
    this.deps.onSignedIn("");
    const after = reported ?? (await input.identity?.().catch(() => undefined));
    const view: SignInView = { state: "done", ...(after ? { email: after } : {}) };
    if (before && after && before.toLowerCase() !== after.toLowerCase()) {
      view.warning = `${input.label ?? "This account"} now signs in as ${after} instead of ${before}. Chats that use it will run as ${after}.`;
    }
    return view;
  }

  private track(id: string, input: { accountId: string; kind: AccountKind }, rest: Pick<Entry, "claude" | "codex" | "view">): Entry {
    const entry: Entry = { id, accountId: input.accountId, kind: input.kind, ...rest, expires: setTimeout(() => void this.cancel(id), EXPIRY_MS) };
    (entry.expires as { unref?: () => void }).unref?.();
    this.sessions.set(id, entry);
    return entry;
  }

  private finish(id: string, view: SignInView) {
    const entry = this.sessions.get(id);
    if (!entry || entry.view.state !== "waiting") return;
    entry.view = view;
    if (view.state === "done") this.deps.onSignedIn(entry.accountId);
  }

  view(sessionId: string): SignInView {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { state: "failed", error: "This sign-in has ended. Start again." };
    // The host-only link can appear a moment after the session starts.
    if (entry.view.state === "waiting" && entry.claude?.start.localUrl && !entry.view.localUrl) entry.view = { ...entry.view, localUrl: entry.claude.start.localUrl };
    return entry.view;
  }

  async submitCode(sessionId: string, code: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry?.claude) return { ok: false as const, retry: false, error: "This sign-in has ended. Start again." };
    const result = await entry.claude.submitCode(code);
    return result.ok ? { ok: true as const, retry: false } : { ok: false as const, retry: result.retry, error: result.error };
  }

  async cancel(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    clearTimeout(entry.expires);
    await (entry.claude ?? entry.codex)?.cancel().catch(() => undefined);
  }

  async dispose() {
    await Promise.all([...this.sessions.keys()].map((id) => this.cancel(id)));
  }
}

