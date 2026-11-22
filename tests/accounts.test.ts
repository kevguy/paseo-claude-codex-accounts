import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { accountsFromConfig, addAccount, clearStatusCache, listAccounts, mapLimit, removeAccount, signInArgv, updateAccount, type ConfigApi, type Host } from "../server/accounts";
import { claudeKeychainService, claudeStatus, codexStatus, jwtClaims } from "../server/status";
import { signInCommands, signInTerminalArgv, slugify } from "../shared/accounts";

const fixtures = join(process.cwd(), ".validation", "accounts");
let sequence = 0;
async function fakeHome() {
  const path = join(fixtures, `home-${process.pid}-${sequence++}`);
  await mkdir(path, { recursive: true });
  return path;
}

/** An in-memory stand-in for Paseo's config API that applies patches like the daemon does. */
function fakeConfig(initial: Record<string, Record<string, unknown>> = {}) {
  const providers: Record<string, Record<string, unknown>> = structuredClone(initial);
  const calls: unknown[] = [];
  const api: ConfigApi = {
    async get() { return { config: { providers: structuredClone(providers) } }; },
    async patch(patch) {
      calls.push(patch);
      for (const id of patch.removeProviders ?? []) delete providers[id];
      for (const [id, entry] of Object.entries(patch.providers ?? {})) providers[id] = { ...providers[id], ...entry };
      return {};
    },
  };
  return { api, providers, calls };
}

function makeHost(home: string, config: ConfigApi, platform: NodeJS.Platform = "linux"): Host {
  return { config, homedir: home, platform, keychainHas: async () => false };
}

function fakeJwt(claims: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

test("slugify keeps names usable as provider ids and folder names", () => {
  assert.equal(slugify("Work"), "work");
  assert.equal(slugify("  Team 7 / Client  "), "team-7-client");
  assert.equal(slugify("Côté perso"), "cote-perso");
  assert.equal(slugify("2nd"), "2nd");
  assert.equal(slugify("!!!"), null);
  assert.equal(slugify("x".repeat(80))?.length, 31);
});

test("Keychain item names match Claude's per-folder naming", () => {
  assert.equal(claudeKeychainService(null), "Claude Code-credentials");
  assert.equal(claudeKeychainService("/home/alex/.claude-work"), "Claude Code-credentials-37b8b2f1");
  assert.equal(claudeKeychainService("/Users/alex/.claude-team-7"), "Claude Code-credentials-5f33c7b8");
});

test("sign-in commands set the folder for extra accounts but never for the default", () => {
  const [posix, ps] = signInCommands("claude", "/home/alex/.claude-work");
  assert.equal(posix!.text, "mkdir -p '/home/alex/.claude-work' && CLAUDE_CONFIG_DIR='/home/alex/.claude-work' claude auth login");
  assert.equal(ps!.text, "New-Item -ItemType Directory -Force -Path '/home/alex/.claude-work' | Out-Null; $env:CLAUDE_CONFIG_DIR = '/home/alex/.claude-work'; claude auth login");
  assert.deepEqual(signInCommands("codex", null).map((c) => c.text), ["codex login", "codex login"]);
  assert.match(signInCommands("claude", "/home/o'neil/.claude-a")[0]!.text, /'\/home\/o'\\''neil\/\.claude-a'/);
});

test("terminal argv needs no shell on POSIX and uses cmd.exe on Windows", () => {
  assert.deepEqual(signInTerminalArgv("codex", "/home/alex/.codex-work", "linux"), { command: "env", args: ["CODEX_HOME=/home/alex/.codex-work", "codex", "login"] });
  assert.deepEqual(signInTerminalArgv("claude", null, "darwin"), { command: "claude", args: ["auth", "login"] });
  assert.deepEqual(signInTerminalArgv("claude", "C:\\Users\\alex\\.claude-work", "win32"), { command: "cmd.exe", args: ["/d", "/s", "/c", 'set "CLAUDE_CONFIG_DIR=C:\\Users\\alex\\.claude-work"&& claude auth login'] });
  assert.deepEqual(signInTerminalArgv("codex", null, "win32"), { command: "cmd.exe", args: ["/d", "/s", "/c", "codex login"] });
  assert.throws(() => signInTerminalArgv("claude", "C:\\Users\\a&b\\.claude-x", "win32"), /cmd\.exe/);
});

test("accounts come from the defaults plus every entry with its own folder, for any number of accounts", () => {
  const providers: Record<string, unknown> = {
    "zai": { extends: "claude", label: "Z.AI", env: { ANTHROPIC_BASE_URL: "https://example.invalid" } },
    "gemini": { extends: "acp", label: "Gemini", command: ["gemini", "--acp"] },
    "codex": { enabled: false },
    "codex-team": { extends: "codex", label: "Codex (team)", env: { CODEX_HOME: "/h/.codex-team" } },
    "legacy-work": { extends: "claude", label: "Old work", env: { CLAUDE_CONFIG_DIR: "/h/.claude-old" } },
  };
  for (let i = 10; i >= 1; i--) providers[`claude-acct-${i}`] = { extends: "claude", label: `Claude (acct ${String(i).padStart(2, "0")})`, env: { CLAUDE_CONFIG_DIR: `/h/.claude-acct-${i}` } };
  const rows = accountsFromConfig(providers, { homedir: "/h", platform: "linux" });
  assert.equal(rows.filter((r) => r.kind === "claude").length, 12); // default + 10 + legacy
  assert.equal(rows.filter((r) => r.kind === "codex").length, 2);
  assert.ok(!rows.some((r) => r.id === "zai" || r.id === "gemini"));
  assert.equal(rows[0]!.id, "claude");
  assert.equal(rows[0]!.home, "/h/.claude");
  assert.deepEqual(rows.slice(1, 4).map((r) => r.label), ["Claude (acct 01)", "Claude (acct 02)", "Claude (acct 03)"]);
  assert.equal(rows.find((r) => r.id === "codex")!.enabled, false);
  assert.equal(rows.find((r) => r.id === "legacy-work")!.managed, false);
  assert.equal(rows.find((r) => r.id === "claude-acct-7")!.managed, true);
});

test("Claude status reads identity and the credentials file without exposing tokens", async () => {
  const home = await fakeHome();
  try {
    const dir = join(home, ".claude-work");
    await mkdir(dir, { recursive: true });
    const env = { platform: "linux" as const, homedir: home };
    assert.deepEqual(await claudeStatus(dir, env), { state: "signed-out" });
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "alex@example.com", organizationName: "Example Co", organizationType: "claude_enterprise" } }));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: 1 } }));
    const status = await claudeStatus(dir, env);
    assert.deepEqual(status, { state: "signed-in", email: "alex@example.com", organization: "Example Co", plan: "Enterprise" });
    assert.ok(!JSON.stringify(status).includes("secret"));
    // The default account keeps its identity at ~/.claude.json and credentials in ~/.claude.
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", planDisplayName: "Max" } }));
    assert.deepEqual(await claudeStatus(null, env), { state: "signed-out" });
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    assert.deepEqual(await claudeStatus(null, env), { state: "signed-in", email: "me@example.com", plan: "Max" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("on macOS Claude status asks the Keychain for the folder's own item", async () => {
  const home = await fakeHome();
  try {
    const dir = join(home, ".claude-work");
    await mkdir(dir, { recursive: true });
    const asked: string[] = [];
    const env = { platform: "darwin" as const, homedir: home, keychainHas: async (service: string) => { asked.push(service); return service === claudeKeychainService(dir); } };
    assert.equal((await claudeStatus(dir, env)).state, "signed-in");
    assert.equal((await claudeStatus(null, env)).state, "signed-out");
    assert.deepEqual(asked, [claudeKeychainService(dir), "Claude Code-credentials"]);
    assert.equal((await claudeStatus(dir, { ...env, keychainHas: async () => null })).state, "unknown");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex status reads auth.json identity claims only", async () => {
  const home = await fakeHome();
  try {
    const dir = join(home, ".codex-work");
    await mkdir(dir, { recursive: true });
    assert.deepEqual(await codexStatus(dir, { platform: "linux", homedir: home }), { state: "signed-out" });
    const idToken = fakeJwt({ email: "alex@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } });
    await writeFile(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: "secret-access", refresh_token: "secret-refresh", account_id: "acct" } }));
    const status = await codexStatus(dir, { platform: "linux", homedir: home });
    assert.deepEqual(status, { state: "signed-in", email: "alex@example.com", plan: "ChatGPT Plus" });
    assert.ok(!JSON.stringify(status).includes("secret"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-secret" }));
    assert.deepEqual(await codexStatus(dir, { platform: "linux", homedir: home }), { state: "signed-in", plan: "API key" });
    await writeFile(join(dir, "auth.json"), "{not json");
    assert.equal((await codexStatus(dir, { platform: "linux", homedir: home })).state, "unknown");
    assert.equal(jwtClaims("not-a-jwt"), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("adding accounts creates folders and provider entries, for the tenth as for the first", async () => {
  const home = await fakeHome();
  try {
    const { api, providers } = fakeConfig();
    const host = makeHost(home, api);
    for (let i = 1; i <= 10; i++) {
      const account = await addAccount(host, "claude", `Team ${i}`);
      assert.equal(account.id, `claude-team-${i}`);
      assert.equal(account.label, `Claude (Team ${i})`);
      assert.equal(account.home, join(home, `.claude-team-${i}`));
      assert.equal(account.status.state, "signed-out");
      assert.ok((await stat(account.home)).isDirectory());
    }
    const codex = await addAccount(host, "codex", "Work");
    assert.deepEqual(providers["codex-work"], { extends: "codex", label: "Codex (Work)", env: { CODEX_HOME: join(home, ".codex-work") } });
    assert.ok((await stat(codex.home)).isDirectory());
    await assert.rejects(addAccount(host, "claude", "team 3"), /already/);
    await assert.rejects(addAccount(host, "claude", "???"), /letter or number/);
    const all = await listAccounts(host, { refresh: true });
    assert.equal(all.filter((a) => a.kind === "claude").length, 11);
    assert.equal(all.filter((a) => a.managed).length, 11);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an existing folder and its login are adopted when the account is added again", async () => {
  const home = await fakeHome();
  try {
    await mkdir(join(home, ".codex-work"), { recursive: true });
    await writeFile(join(home, ".codex-work", "auth.json"), JSON.stringify({ tokens: { id_token: fakeJwt({ email: "kept@example.com" }) } }));
    const account = await addAccount(makeHost(home, fakeConfig().api), "codex", "work");
    assert.equal(account.status.state, "signed-in");
    assert.equal(account.status.email, "kept@example.com");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("hiding, renaming and removing respect which accounts this plugin manages", async () => {
  const home = await fakeHome();
  try {
    const { api, providers, calls } = fakeConfig({ "legacy": { extends: "claude", label: "Legacy", env: { CLAUDE_CONFIG_DIR: join(home, ".claude-legacy") } } });
    const host = makeHost(home, api);
    const added = await addAccount(host, "claude", "Work");
    await updateAccount(host, added.id, { enabled: false, label: "Claude (Office)" });
    assert.equal(providers[added.id]!.enabled, false);
    assert.equal(providers[added.id]!.label, "Claude (Office)");
    await updateAccount(host, "claude", { enabled: false });
    assert.deepEqual(providers.claude, { enabled: false });
    await assert.rejects(updateAccount(host, "claude", { label: "Mine" }), /renamed/);
    await assert.rejects(removeAccount(host, "legacy"), /removed/);
    await assert.rejects(removeAccount(host, "claude"), /removed/);
    const removed = await removeAccount(host, added.id);
    assert.equal(providers[added.id], undefined);
    assert.ok((await stat(removed.home)).isDirectory(), "the folder and its login stay");
    assert.deepEqual(calls.at(-1), { removeProviders: [added.id] });
    await assert.rejects(removeAccount(host, added.id), /no longer exists/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("sign-in for a default account leaves the folder variable unset", async () => {
  const home = await fakeHome();
  try {
    const host = makeHost(home, fakeConfig().api, "linux");
    assert.deepEqual((await signInArgv(host, "claude")).args, ["auth", "login"]);
    assert.deepEqual(await readdir(home), [], "no folder is created for a default account");
    const added = await addAccount(host, "claude", "Work");
    const argv = await signInArgv(host, added.id);
    assert.equal(argv.command, "env");
    assert.deepEqual(argv.args, [`CLAUDE_CONFIG_DIR=${added.home}`, "claude", "auth", "login"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("status is cached per folder and refreshed on request", async () => {
  const home = await fakeHome();
  try {
    clearStatusCache();
    const host = makeHost(home, fakeConfig().api);
    const added = await addAccount(host, "codex", "Cache");
    assert.equal((await listAccounts(host)).find((a) => a.id === added.id)!.status.state, "signed-out");
    await writeFile(join(added.home, "auth.json"), JSON.stringify({ tokens: { id_token: fakeJwt({ email: "a@example.com" }) } }));
    assert.equal((await listAccounts(host)).find((a) => a.id === added.id)!.status.state, "signed-out", "cached");
    assert.equal((await listAccounts(host, { refresh: true })).find((a) => a.id === added.id)!.status.state, "signed-in");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("status checks run with bounded concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return i * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => i * 2));
});
