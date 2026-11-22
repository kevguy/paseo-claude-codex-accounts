/// <reference types="node" />
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ClaudeLoginStart {
  url: string;
  readonly localUrl?: string;
}

export interface ClaudeLoginSession {
  start: ClaudeLoginStart;
  submitCode(code: string): Promise<{ ok: true } | { ok: false; error: string; retry: boolean }>;
  done: Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(): Promise<void>;
}

export interface ClaudeLoginDeps {
  spawn: typeof import("node:child_process").spawn;
  command: string[];
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  shimDir: string;
  email?: string;
  timeoutMs?: number;
}

const AUTH_ENV = ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function authorizeUrl(text: string): string | null {
  const match = text.match(/https:\/\/[^\s"'<>]*\/oauth\/authorize[^\s"'<>]*/);
  return match?.[0]?.replace(/[),.;]+$/, "") ?? null;
}

/** @param configDir the account's folder, or null for the default login (no CLAUDE_CONFIG_DIR, as the CLI expects). */
export async function startClaudeLogin(configDir: string | null, deps: ClaudeLoginDeps): Promise<ClaudeLoginSession> {
  if (deps.email !== undefined && !EMAIL.test(deps.email)) throw new Error("Enter a valid email address.");
  if (configDir) await mkdir(configDir, { recursive: true });
  await mkdir(deps.shimDir, { recursive: true });
  const id = randomUUID();
  const outputFile = join(deps.shimDir, `claude-browser-${id}.url`);
  const shimFile = join(deps.shimDir, `claude-browser-${id}${deps.platform === "win32" ? ".cmd" : ".sh"}`);
  const args = [...deps.command.slice(1), "auth", "login", "--claudeai", ...(deps.email ? ["--email", deps.email] : [])];
  const env: Record<string, string | undefined> = { ...deps.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  for (const key of AUTH_ENV) delete env[key];
  // cmd.exe expansion and quoting differ across Node versions; stdout remains the portable fallback.
  const useShim = deps.platform !== "win32";
  if (useShim) {
    await writeFile(shimFile, "#!/bin/sh\nprintf '%s' \"$1\" > \"$BATON_BROWSER_OUT\"\n", { mode: 0o700 });
    await chmod(shimFile, 0o700);
    env.BROWSER = shimFile;
    env.BATON_BROWSER_OUT = outputFile;
  } else {
    delete env.BROWSER;
    delete env.BATON_BROWSER_OUT;
  }
  const command = deps.command[0]!;
  // With a shell, a path with spaces must be quoted; the arguments are fixed or validated.
  const child = deps.spawn(deps.platform === "win32" && /\.cmd$/i.test(command) ? `"${command}"` : command, args, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], ...(deps.platform === "win32" && /\.cmd$/i.test(command) ? { shell: true } : {}) });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let output = "";
  let stderr = "";
  let submittedAt = 0;
  let invalidCode = false;
  let exited = false;
  let canceled = false;
  let localUrl: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let resolveStart!: (value: ClaudeLoginStart) => void;
  let rejectStart!: (error: Error) => void;
  let signalResponse: (() => void) | undefined;
  let settledDone = false;
  const startPromise = new Promise<ClaudeLoginStart>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  let startValue: ClaudeLoginStart | undefined;
  const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      if (settledDone) return;
      settledDone = true;
      resolve(result);
      signalResponse?.();
    };
    const cleanup = () => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      if (startTimer) clearTimeout(startTimer);
      if (responseTimer) clearTimeout(responseTimer);
      if (poll) clearInterval(poll);
      void Promise.all([rm(outputFile, { force: true }), rm(shimFile, { force: true })]);
    };
    child.once("error", (error) => {
      cleanup();
      if (!startValue) rejectStart(new Error(`Could not start Claude: ${error.message}`));
      finish({ ok: false, error: `Could not start Claude: ${error.message}` });
    });
    child.once("close", (code) => {
      cleanup();
      if (!startValue) rejectStart(new Error("Claude did not provide a sign-in URL."));
      if (canceled) finish({ ok: false, error: "Sign-in was canceled." });
      else if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: "Claude sign-in did not finish." });
    });
  });
  const checkUrl = () => {
    if (startValue) return;
    const url = authorizeUrl(output);
    if (!url) return;
    startValue = { url, get localUrl() { return localUrl; } };
    resolveStart(startValue);
  };
  child.stdout?.on("data", (chunk: string) => { output = (output + chunk.replace(ANSI, "")).slice(-32_768); checkUrl(); });
  child.stderr?.on("data", (chunk: string) => {
    const clean = chunk.replace(ANSI, "");
    stderr = (stderr + clean).slice(-16_384);
    if (submittedAt && Date.now() - submittedAt <= 5_000 && /invalid.{0,30}code|code.{0,30}invalid/i.test(stderr)) {
      invalidCode = true;
      signalResponse?.();
    }
  });
  startTimer = setTimeout(() => {
    if (startValue || exited) return;
    rejectStart(new Error("Timed out waiting for Claude sign-in URL."));
    canceled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000);
    if (poll) clearInterval(poll);
    void Promise.all([rm(outputFile, { force: true }), rm(shimFile, { force: true })]);
  }, deps.timeoutMs ?? 30_000);
  if (useShim) {
    poll = setInterval(() => {
      void readFile(outputFile, "utf8").then((value) => { const captured = value.trim(); if (captured.startsWith("http")) localUrl = captured; }).catch(() => undefined);
    }, 250);
  }
  const start = await startPromise;
  if (startTimer) clearTimeout(startTimer);
  return {
    start,
    done,
    async submitCode(code: string) {
      const value = code.trim();
      if (!value || /\s/.test(value)) return { ok: false, retry: true, error: "Paste a valid code without spaces or line breaks." };
      if (!value.includes("#")) return { ok: false, retry: true, error: "Paste the whole code shown on the page, including the part after #." };
      if (exited || canceled) return { ok: false, retry: false, error: "This sign-in has ended. Start again." };
      invalidCode = false;
      stderr = "";
      submittedAt = Date.now();
      child.stdin?.write(`${value}\n`);
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (responseTimer) clearTimeout(responseTimer);
          responseTimer = undefined;
          signalResponse = undefined;
          resolve();
        };
        signalResponse = finish;
        responseTimer = setTimeout(finish, 5_000);
        if (invalidCode || exited) finish();
      });
      if (invalidCode) return { ok: false, retry: true, error: "That code was not accepted. Copy it again from the page." };
      // The CLI exits when it rejects a code, so a new attempt needs a new sign-in.
      if (exited) { const result = await done; return result.ok ? { ok: true } : { ok: false, retry: false, error: "Claude didn't accept that code. Start again, and copy the whole code from the page." }; }
      return { ok: true };
    },
    async cancel() {
      if (!exited && !canceled) {
        canceled = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000);
      }
      if (poll) clearInterval(poll);
      if (startTimer) clearTimeout(startTimer);
      if (responseTimer) clearTimeout(responseTimer);
      signalResponse?.();
      await Promise.all([rm(outputFile, { force: true }), rm(shimFile, { force: true })]);
    },
  };
}
