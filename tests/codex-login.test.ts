import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { startCodexLogin, type CodexLoginDeps } from "../server/codex-login";

const fixture = join(process.cwd(), "tests", "fixtures", "codex-login", "fake-app-server.mjs");
const validationRoot = join(process.cwd(), ".validation");
let fixtureRoot: string;
let homeNumber = 0;
async function makeHome() {
  fixtureRoot ??= await mkdtemp(join(validationRoot, "codex-login-"));
  return mkdtemp(join(fixtureRoot, `home-${process.pid}-${homeNumber++}-`));
}
after(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });
function deps(mode: string, extra: Partial<CodexLoginDeps> = {}): CodexLoginDeps {
  return {
    spawn,
    command: [process.execPath, fixture, mode],
    platform: process.platform,
    env: { ...process.env, OPENAI_API_KEY: "inherited-key", CODEX_API_KEY: "inherited-key" },
    ...extra,
  };
}

test("starts browser login with the app-server protocol and returns account details", async () => {
  const parent = await makeHome();
  try {
    const home = join(parent, "missing", "codex-home");
    const session = await startCodexLogin(home, "browser", deps("success"));
    assert.deepEqual(session.start, { method: "browser", url: "https://example.test/auth" });
    assert.deepEqual(await session.done, { ok: true, email: "alex@example.com", plan: "plus" });
    assert.equal((await stat(home)).isDirectory(), true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("starts device-code login with its verification URL and user code", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "device-code", deps("device-success"));
    assert.deepEqual(session.start, { method: "device-code", url: "https://example.test/device", code: "ABCD-EFGH" });
    assert.deepEqual(await session.done, { ok: true, email: "alex@example.com", plan: "plus" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("maps a server-side login failure to plain English", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "browser", deps("failure"));
    assert.deepEqual(await session.done, { ok: false, error: "Sign-in was canceled" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("explains when device-code sign-in is disabled", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "device-code", deps("device-disabled"));
    assert.deepEqual(await session.done, { ok: false, error: "Device-code sign-in is off for this ChatGPT account. Turn it on in ChatGPT → Settings → Security, or use browser sign-in." });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("reports early exit code and redacts token-looking stderr", async () => {
  const parent = await makeHome();
  try {
    await assert.rejects(startCodexLogin(join(parent, "codex"), "browser", deps("early-exit")), /exited early \(code 17\).*\[redacted\]/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("cancel sends account/login/cancel and resolves the session", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "browser", deps("idle"));
    await session.cancel();
    assert.deepEqual(await session.done, { ok: false, error: "Sign-in was canceled" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("times out and ends a stalled login", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "browser", deps("idle", { timeoutMs: 300 }));
    assert.deepEqual(await session.done, { ok: false, error: "Sign-in timed out" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("ignores unrelated completion notifications and answers server requests", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "browser", deps("unknown-request"));
    assert.deepEqual(await session.done, { ok: true, email: "alex@example.com", plan: "plus" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("removes inherited API keys from the child environment", async () => {
  const parent = await makeHome();
  try {
    const session = await startCodexLogin(join(parent, "codex"), "browser", deps("env-check", { env: { OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", KEEP_ME: "yes" } }));
    assert.deepEqual(await session.done, { ok: true, email: "alex@example.com", plan: "plus" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
