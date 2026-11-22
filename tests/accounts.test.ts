import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import test from "node:test";
import { accountsFromConfig, addAccount, clearStatusCache, listAccounts, mapLimit, removeAccount, signInArgv, updateAccount, type ConfigApi, type Host } from "../server/accounts";
import { discoverAccounts, folderKey, paseoConfigPath, readProviders } from "../server/usage";
import { claudeKeychainService, claudeStatus, codexStatus, jwtClaims } from "../server/status";
import { displayPath, powershellArgv, powershellQuote, signInCommands, signInTerminalArgv, slugify } from "../shared/accounts";

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
  assert.equal(ps!.text, "New-Item -ItemType Directory -Force -Path '/home/alex/.claude-work' | Out-Null; $env:CLAUDE_CONFIG_DIR = '/home/alex/.claude-work'; try { claude auth login } finally { Remove-Item Env:CLAUDE_CONFIG_DIR }");
  assert.deepEqual(signInCommands("codex", null).map((c) => c.text), ["codex login", "codex login"]);
  assert.match(signInCommands("claude", "/home/o'neil/.claude-a")[0]!.text, /'\/home\/o'\\''neil\/\.claude-a'/);
  const [shortPosix, shortPs] = signInCommands("codex", "/home/alex/.codex-work", { homedir: "/home/alex", platform: "linux" });
  assert.equal(shortPosix!.text, 'mkdir -p "$HOME/.codex-work" && CODEX_HOME="$HOME/.codex-work" codex login');
  assert.equal(shortPs!.text, 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.codex-work" | Out-Null; $env:CODEX_HOME = "$env:USERPROFILE\\.codex-work"; try { codex login } finally { Remove-Item Env:CODEX_HOME }');
  assert.match(signInCommands("claude", "C:\\Users\\Alex\\.claude-work", { homedir: "C:\\Users\\Alex", platform: "win32" })[1]!.text, /"\$env:USERPROFILE\\\.claude-work"/);
  // Anything unusual under the home folder keeps the full single-quoted path.
  assert.match(signInCommands("claude", "/home/alex/my $dir", { homedir: "/home/alex", platform: "linux" })[0]!.text, /'\/home\/alex\/my \$dir'/);
});

const decodeEncodedCommand = (args: string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le");

test("terminal argv needs no shell on POSIX and passes an encoded script to PowerShell on Windows", () => {
  assert.deepEqual(signInTerminalArgv("codex", "/home/alex/.codex-work", "linux"), { command: "env", args: ["CODEX_HOME=/home/alex/.codex-work", "codex", "login"] });
  assert.deepEqual(signInTerminalArgv("claude", null, "darwin"), { command: "claude", args: ["auth", "login"] });
  const work = signInTerminalArgv("claude", "C:\\Users\\O\u2019Brien & Co\\.claude-work", "win32");
  assert.equal(work.command, "powershell.exe");
  assert.deepEqual(work.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.match(work.args.at(-1)!, /^[A-Za-z0-9+/=]+$/);
  assert.equal(decodeEncodedCommand(work.args), "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O\u2019\u2019Brien & Co\\.claude-work'; claude auth login");
  assert.equal(decodeEncodedCommand(signInTerminalArgv("codex", null, "win32").args), "codex login");
});

test("PowerShell quoting doubles ASCII and typographic single quotes", () => {
  assert.equal(powershellQuote("C:\\Users\\o'neil"), "'C:\\Users\\o''neil'");
  assert.equal(powershellQuote("\u2018a\u2019b\u201Ac\u201Bd"), "'\u2018\u2018a\u2019\u2019b\u201A\u201Ac\u201B\u201Bd'");
});

test("on Windows, the encoded script sets the variable to the exact path", { skip: process.platform !== "win32" }, () => {
  const path = "C:\\Users\\O\u2019Brien & Co\\it's \"quoted\" %PATH% ^ | < >\\.claude-work";
  const { command, args } = powershellArgv(`$env:CLAUDE_CONFIG_DIR = ${powershellQuote(path)}; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $env:CLAUDE_CONFIG_DIR`);
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path);
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

test("displayPath shortens folders under the home folder only", () => {
  assert.equal(displayPath("/Users/alex/.claude-work", "/Users/alex", "darwin"), "~/.claude-work");
  assert.equal(displayPath("/Users/alex", "/Users/alex/", "linux"), "~");
  assert.equal(displayPath("/Users/alexandra/.claude", "/Users/alex", "darwin"), "/Users/alexandra/.claude");
  assert.equal(displayPath("/srv/accounts/.codex-ci", "/home/alex", "linux"), "/srv/accounts/.codex-ci");
  assert.equal(displayPath("C:\\Users\\Alex\\.codex-work", "c:\\users\\alex", "win32"), "~\\.codex-work");
  assert.equal(displayPath("D:\\accounts\\.claude-x", "C:\\Users\\Alex", "win32"), "D:\\accounts\\.claude-x");
  // Lower-casing "İ" adds a character; the folder name must still come out whole.
  assert.equal(displayPath("C:\\Users\\İrem\\.claude-work", "C:\\Users\\İrem", "win32"), "~\\.claude-work");
  assert.equal(displayPath("C:\\Users\\irem\\.claude-work", "C:\\Users\\İrem", "win32"), "C:\\Users\\irem\\.claude-work");
  assert.equal(displayPath("/home/alex/", "/home/alex", "linux"), "~");
});

test("a malformed credential file is reported without repeating its contents", async () => {
  const home = await fakeHome();
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", ".credentials.json"), "sk-ant-oat01-SECRETSECRET");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "sk-proj-SECRETSECRET");
  const env = { platform: "linux" as const, homedir: home };
  for (const status of [await claudeStatus(null, env), await codexStatus(join(home, ".codex"), env)]) {
    assert.equal(status.state, "unknown");
    assert.match(status.detail!, /isn't valid JSON/);
    assert.doesNotMatch(JSON.stringify(status), /sk-|SECRET/);
  }
  await rm(home, { recursive: true, force: true });
});

test("concurrent adds of the same name create one account, and renames keep labels unique", async () => {
  const home = await fakeHome();
  const config = fakeConfig();
  const host = makeHost(home, config.api);
  const results = await Promise.allSettled([addAccount(host, "claude", "Work"), addAccount(host, "claude", "work")]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /becomes the provider id claude-work/);
  await addAccount(host, "claude", "Personal");
  await assert.rejects(updateAccount(host, "claude-personal", { label: "claude (work)" }), /already an account called/);
  await assert.rejects(updateAccount(host, "claude-personal", { label: "  " }), /needs a name/);
  await updateAccount(host, "claude-personal", { label: " Claude (Home) " });
  assert.equal(config.providers["claude-personal"]!.label, "Claude (Home)");
  await rm(home, { recursive: true, force: true });
});

test("a folder variable in the daemon's environment moves the default account", () => {
  const rows = accountsFromConfig({}, { homedir: "/home/alex", platform: "linux", env: { CODEX_HOME: "/srv/codex" } });
  const codex = rows.find((row) => row.id === "codex")!;
  assert.equal(codex.home, "/srv/codex");
  assert.equal(codex.defaultHome, false);
  assert.equal(rows.find((row) => row.id === "claude")!.defaultHome, true);
});

test("sign-in refuses a folder that isn't a full path", async () => {
  const home = await fakeHome();
  const config = fakeConfig({ "claude-odd": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-odd" } } });
  await assert.rejects(signInArgv(makeHost(home, config.api), "claude-odd"), /isn't a full path/);
  await rm(home, { recursive: true, force: true });
});

test("usage lists every extra account, looked up in its own folder, and nothing for sessions", async () => {
  const providers = {
    claude: { label: "Claude" },
    "claude-work": { extends: "claude", label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: "/home/alex/.claude-work" } },
    "claude-research": { extends: "claude", label: "Claude (Research)", env: { CLAUDE_CONFIG_DIR: "/home/alex/.claude-research" }, enabled: false },
    "codex-work": { extends: "codex", label: "Codex (Work)", env: { CODEX_HOME: "/home/alex/.codex-work" } },
    zai: { extends: "claude", env: { ANTHROPIC_BASE_URL: "https://example.invalid" } },
  };
  const seen: unknown[] = [];
  const host = {
    env: { HOME: "/home/alex", USER: "alex", CLAUDE_CONFIG_DIR: "/should/not/leak", PATH: "/usr/bin" },
    homedir: "/home/alex",
    platform: "linux" as const,
    providers: async () => providers,
    discover: {
      claude: async (scope: UsageScope) => {
        seen.push(scope);
        const dir = scope.kind === "session" ? scope.env.CLAUDE_CONFIG_DIR : "";
        return dir.endsWith("research") ? [] : [{ key: "uuid.org", label: "alex@northwind.example", input: { route: { store: "claude", path: `${dir}/.credentials.json` } } }];
      },
      codex: async () => [{ key: "acct", input: { route: { store: "codex", path: "/home/alex/.codex-work/auth.json" } } }],
    },
  };
  assert.deepEqual(await discoverAccounts("claude", { kind: "session", provider: "claude", env: {} }, host), []);
  const claude = await discoverAccounts("claude", { kind: "global" }, host);
  assert.deepEqual(claude.map((a) => a.label), ["Claude (Work) · alex@northwind.example"]);
  assert.deepEqual(claude.map((a) => a.key), ["claude-work.uuid.org"]);
  assert.deepEqual(seen, [
    { kind: "session", provider: "claude", env: { HOME: "/home/alex", USER: "alex", CLAUDE_CONFIG_DIR: "/home/alex/.claude-research" } },
    { kind: "session", provider: "claude", env: { HOME: "/home/alex", USER: "alex", CLAUDE_CONFIG_DIR: "/home/alex/.claude-work" } },
  ]);
  assert.deepEqual((await discoverAccounts("codex", { kind: "global" }, host)).map((a) => a.label), ["Codex (Work)"]);
});

test("usage keys stay per folder, so two seats of one workspace keep their own cards", async () => {
  const providers = {
    "codex-work": { extends: "codex", label: "Codex (Work)", env: { CODEX_HOME: "/home/alex/.codex-work" } },
    "codex-client": { extends: "codex", label: "Codex (Client)", env: { CODEX_HOME: "/home/alex/.codex-client" } },
  };
  const host = {
    env: { HOME: "/home/alex" },
    homedir: "/home/alex",
    platform: "linux" as const,
    providers: async () => providers,
    discover: {
      claude: async () => [],
      codex: async () => [{ key: "same-workspace", input: { route: { store: "codex", path: "x" } } }],
    },
  };
  const keys = (await discoverAccounts("codex", { kind: "global" }, host)).map((a) => a.key);
  assert.deepEqual(keys.sort(), ["codex-client.same-workspace", "codex-work.same-workspace"]);
  assert.equal(folderKey("claude-x", "k".repeat(200)).length, 128);
});

test("a broken config.json is reported without quoting it", async () => {
  const home = await fakeHome();
  await mkdir(join(home, ".paseo"), { recursive: true });
  await writeFile(join(home, ".paseo", "config.json"), '{"agents": sk-ant-api03-SECRET');
  await assert.rejects(readProviders({}, home), (error: Error) => /isn't valid JSON/.test(error.message) && !/SECRET|sk-/.test(error.message));
  await rm(home, { recursive: true, force: true });
});

test("usage finds Paseo's config where the daemon keeps it", () => {
  assert.equal(paseoConfigPath({}, "/home/alex"), join("/home/alex", ".paseo", "config.json"));
  assert.equal(paseoConfigPath({ PASEO_HOME: "~/custom" }, "/home/alex"), join("/home/alex", "custom", "config.json"));
  assert.equal(paseoConfigPath({ PASEO_HOME: "/srv/paseo" }, "/home/alex"), join(resolve("/srv/paseo"), "config.json"));
  assert.equal(paseoConfigPath({ PASEO_HOME: "~" }, "/home/alex"), join(resolve("/home/alex"), "config.json"));
});
