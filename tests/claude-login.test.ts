import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { startClaudeLogin, type ClaudeLoginDeps } from "../server/claude-login";

const made: string[] = [];
after(async () => { await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))); });

function track(dir: string) {
  made.push(dir);
  return dir;
}

async function validationDir() {
  const dir = join(process.cwd(), ".validation");
  await mkdir(dir, { recursive: true });
  return dir;
}

const fixture = fileURLToPath(new URL("./fixtures/claude-login/fake-claude.mjs", import.meta.url));
async function setup(overrides: Partial<ClaudeLoginDeps> = {}) {
  const root = track(await mkdtemp(join(await validationDir(), "claude-login-test-")));
  const config = join(root, "config");
  const shimDir = join(root, "shim");
  const deps: ClaudeLoginDeps = { spawn, command: [process.execPath, fixture], platform: process.platform, env: {}, shimDir, timeoutMs: 2_000, ...overrides };
  const session = await startClaudeLogin(config, deps);
  return { root, config, shimDir, session };
}

test("captures the HTTPS authorize URL and strips ANSI escapes", async () => {
  const { session } = await setup();
  assert.equal(session.start.url, "https://claude.ai/oauth/authorize?client_id=fake&state=xyz");
  await session.cancel();
});

test("sets config directory and removes inherited credential overrides", async () => {
  const { config, session } = await setup({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong", CLAUDE_CODE_OAUTH_TOKEN: "secret", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_API_KEY: "secret" } });
  assert.ok(config);
  await session.cancel();
});

test("rejects an email that could be unsafe in a Windows shell", async () => {
  await assert.rejects(() => startClaudeLogin("/not-created", { spawn, command: ["claude.cmd"], platform: "win32", env: {}, shimDir: "/not-created", email: "x@example.com & whoami" }), /valid email/);
});

test("won't pass an email with cmd.exe metacharacters to a Windows .cmd shim", async () => {
  const shimDir = await mkdtemp(join(await validationDir(), "claude-shim-"));
  try {
    let spawned = false;
    const fakeSpawn = (() => { spawned = true; throw new Error("should not spawn"); }) as unknown as typeof spawn;
    // Valid by the email rules, but & runs a second command in cmd.exe.
    await assert.rejects(() => startClaudeLogin(null, { spawn: fakeSpawn, command: ["C:\\npm\\claude.cmd"], platform: "win32", env: {}, shimDir, email: "a&calc&@x.com" }), /safely/);
    assert.equal(spawned, false);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
});

test("rejects code without the official state suffix without writing it", async () => {
  const { session } = await setup();
  assert.deepEqual(await session.submitCode("only-code"), { ok: false, retry: true, error: "Paste the whole code shown on the page, including the part after #." });
  await session.cancel();
});

test("rejects empty code", async () => {
  const { session } = await setup();
  assert.equal((await session.submitCode("  ")).ok, false);
  await session.cancel();
});

test("rejects whitespace in code", async () => {
  const { session } = await setup();
  assert.equal((await session.submitCode("good #state")).ok, false);
  await session.cancel();
});

test("reports CLI invalid-code response as retryable", async () => {
  const { session } = await setup();
  assert.deepEqual(await session.submitCode("bad#state"), { ok: false, retry: true, error: "That code was not accepted. Copy it again from the page." });
  await session.done;
});

test("accepts a valid code when the CLI exits successfully", async () => {
  const { session } = await setup();
  assert.deepEqual(await session.submitCode("good#state"), { ok: true });
  assert.deepEqual(await session.done, { ok: true });
});

test("captures localhost URL from the POSIX BROWSER shim and removes output on cancel", async () => {
  const root = track(await mkdtemp(join(await validationDir(), "claude-login-test-")));
  const session = await startClaudeLogin(join(root, "config"), {
    spawn, command: [process.execPath, fixture], platform: process.platform,
    env: { FAKE_LOCAL_URL: "1" }, shimDir: join(root, "shim"), timeoutMs: 2_000,
  });
  const deadline = Date.now() + 2_000;
  while (!session.start.localUrl && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.start.localUrl, "http://localhost:54545/callback");
  await session.cancel();
  const files = await import("node:fs/promises").then((fs) => fs.readdir(join(root, "shim")));
  assert.deepEqual(files, []);
});

test("times out if no authorize URL arrives", async () => {
  const root = track(await mkdtemp(join(await validationDir(), "claude-login-test-")));
  await assert.rejects(() => startClaudeLogin(join(root, "config"), { spawn, command: [process.execPath, "-e", "setTimeout(()=>{},1000)"], platform: process.platform, env: {}, shimDir: join(root, "shim"), timeoutMs: 50 }), /Timed out/);
});
