/// <reference types="node" />
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers";
import { assertPlainShellArgs } from "./shell-args";

export type CodexLoginMethod = "browser" | "device-code";
export type CodexLoginStart = { method: "browser"; url: string } | { method: "device-code"; url: string; code: string };
export interface CodexLoginSession {
  start: CodexLoginStart;
  done: Promise<{ ok: true; email?: string; plan?: string } | { ok: false; error: string }>;
  cancel(): Promise<void>;
}

export interface CodexLoginDeps {
  /** A command name or a fixed argv prefix, such as [process.execPath, fixturePath]. */
  command: string | readonly [string, ...string[]];
  spawn: typeof nodeSpawn;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** How long the app-server has to answer before sign-in starts. */
  startupTimeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;
type RpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function cleanError(value: unknown): string {
  const raw = typeof value === "string" ? value : "Sign-in failed";
  const lower = raw.toLowerCase();
  if (/device.?code|device.?auth/.test(lower) && /(disabled|not enabled|unsupported|not available)/.test(lower)) {
    return "Device-code sign-in is off for this ChatGPT account. Turn it on in ChatGPT → Settings → Security, or use browser sign-in.";
  }
  if (/cancel/.test(lower)) return "Sign-in was canceled";
  if (/network|connection|offline/.test(lower)) return "Couldn't connect while signing in. Check your connection and try again.";
  if (/timed? out|timeout/.test(lower)) return "Sign-in timed out";
  if (/didn't respond/.test(lower)) return "Codex app-server didn't respond. Check that Codex works in a terminal, then try again.";
  return "Sign-in failed. Please try again.";
}

function safeStderr(value: string): string {
  return value.slice(-4096)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sess-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})\b/g, "[redacted]")
    .slice(-200);
}

function exitMessage(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
  const detail = safeStderr(stderr);
  return `Codex app-server exited early (${status})${detail ? `: ${detail}` : ""}`;
}

export async function startCodexLogin(codexHome: string, method: CodexLoginMethod, deps: CodexLoginDeps): Promise<CodexLoginSession> {
  await mkdir(codexHome, { recursive: true });
  const env: Record<string, string | undefined> = { ...deps.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const prefix = typeof deps.command === "string" ? [deps.command] : [...deps.command];
  const command = prefix[0]!;
  const args = [...prefix.slice(1), "app-server"];
  const windowsShim = deps.platform === "win32" && /\.cmd$/i.test(command);
  // cmd.exe parses the arguments it is handed, so they must be plain text; the path is quoted.
  if (windowsShim) assertPlainShellArgs(args);
  const child = deps.spawn(windowsShim ? `"${command}"` : command, args, {
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(windowsShim ? { shell: true } : {}),
  }) as ChildProcessWithoutNullStreams;

  let stderr = "";
  let buffer = "";
  let rpcId = 0;
  let terminal = false;
  let loginId: string | undefined;
  const earlyCompletions: JsonRecord[] = [];
  let resolveDone!: (value: Awaited<CodexLoginSession["done"]>) => void;
  const done = new Promise<Awaited<CodexLoginSession["done"]>>((resolve) => { resolveDone = resolve; });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let finish!: (value: Awaited<CodexLoginSession["done"]>) => void;

  const send = (message: JsonRecord) => {
    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (methodName: string, params?: JsonRecord): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: methodName, ...(params ? { params } : {}) });
  });
  const finishStartupError = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    terminal = true;
    child.stdin.end();
    try { child.kill(); } catch { /* child may already have exited */ }
  };

  let completionChain = Promise.resolve();
  const completeNotification = (params: JsonRecord) => {
    if (terminal) return;
    if (typeof loginId !== "string") {
      earlyCompletions.push(params);
      return;
    }
    if (params.loginId !== loginId) return;
    if (params.success !== true) {
      finish({ ok: false, error: cleanError(params.error) });
      return;
    }
    completionChain = completionChain.then(async () => {
      try {
        const result = record(await request("account/read"));
        const account = record(result?.account);
        finish({
          ok: true,
          ...(typeof account?.email === "string" && account.email ? { email: account.email } : {}),
          ...(typeof account?.planType === "string" && account.planType ? { plan: account.planType } : {}),
        });
      } catch {
        finish({ ok: false, error: "Sign-in completed, but account details couldn't be read." });
      }
    });
  };

  child.stderr.on("data", (chunk: Buffer | string) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { continue; }
      // The real app-server omits the "jsonrpc" field on its messages, so it isn't required here.
      if (!message || typeof message !== "object") continue;
      if (message.method === "account/login/completed") {
        completeNotification(record(message.params) ?? {});
      } else if (typeof message.method === "string" && message.id !== undefined) {
        // App-server requests are not part of this login flow. Reply so the server can continue.
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported by Paseo" } });
      } else if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error !== undefined) {
          const error = record(message.error);
          waiter.reject(new Error(typeof error?.message === "string" ? error.message : "Request failed"));
        } else waiter.resolve(message.result);
      }
    }
  });

  const earlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (terminal) return;
    const error = new Error(exitMessage(code, signal, stderr));
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    finish({ ok: false, error: error.message });
  };
  child.once("error", (error) => {
    const safe = new Error(`Couldn't start Codex app-server (${error.message.slice(0, 120)})`);
    if (!loginId) finishStartupError(safe);
    else finish({ ok: false, error: safe.message });
  });
  child.once("close", earlyExit);

  finish = (value) => {
    if (terminal) return;
    terminal = true;
    const reason = value.ok ? new Error("Sign-in session ended") : new Error(value.error);
    for (const waiter of pending.values()) waiter.reject(reason);
    pending.clear();
    resolveDone(value);
    child.stdin.end();
    const killTimer = delay(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 2000) as unknown as NodeJS.Timeout;
    killTimer.unref();
  };

  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
  const timeout = delay(() => finish({ ok: false, error: "Sign-in timed out" }), timeoutMs) as unknown as NodeJS.Timeout;
  void done.finally(() => clearTimeout(timeout));
  // Paseo gives a plugin request 30 seconds, so an app-server that never answers fails well before that.
  const startup = delay(() => finish({ ok: false, error: "Codex app-server didn't respond" }), deps.startupTimeoutMs ?? 20_000) as unknown as NodeJS.Timeout;
  startup.unref?.();

  try {
    await request("initialize", { clientInfo: { name: "paseo-claude-codex-accounts", version: "1" } });
    send({ jsonrpc: "2.0", method: "initialized" });
    const login = record(await request("account/login/start", { type: method === "browser" ? "chatgpt" : "chatgptDeviceCode" }));
    if (!login || typeof login.loginId !== "string") throw new Error("Invalid sign-in response");
    loginId = login.loginId;
    clearTimeout(startup);
    for (const params of earlyCompletions.splice(0)) completeNotification(params);
    let start: CodexLoginStart;
    if (method === "browser" && login.type === "chatgpt" && typeof login.authUrl === "string") {
      start = { method: "browser", url: login.authUrl };
    } else if (method === "device-code" && login.type === "chatgptDeviceCode" && typeof login.verificationUrl === "string" && typeof login.userCode === "string") {
      start = { method: "device-code", url: login.verificationUrl, code: login.userCode };
    } else throw new Error("Invalid sign-in response");

    return {
      start,
      done,
      async cancel() {
        if (terminal) return;
        // Don't wait long on a server that has stopped answering; shutdown proceeds either way.
        try { await Promise.race([request("account/login/cancel", { loginId: loginId! }), new Promise((resolve) => delay(resolve, 2000))]); } catch { /* shutdown still proceeds */ }
        finish({ ok: false, error: "Sign-in was canceled" });
      },
    };
  } catch (error) {
    finishStartupError(error instanceof Error ? error : new Error("Couldn't start sign-in"));
    if (error instanceof Error && !error.message.startsWith("Codex app-server exited early")) {
      throw new Error(cleanError(error.message));
    }
    throw error;
  }
}
