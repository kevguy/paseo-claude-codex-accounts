// Builds a fictional home folder and an isolated Paseo home for README screenshots.
// Every name, email, organisation and token here is made up. Usage: node fixture.mjs <outDir> <pluginDir>
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? ".validation/demo");
const pluginDir = resolve(process.argv[3] ?? ".");
const home = join(out, "home");
const paseoHome = join(out, "paseo-home");
export const DAEMON_PORT = 6791;
export const WEB_PORT = 6792;

const jwt = (claims) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.fictional`;
};
const fakeOauth = { claudeAiOauth: { accessToken: "fictional", refreshToken: "fictional", expiresAt: 4102444800000, scopes: [] } };

async function claude(folder, identity, signedIn) {
  const dir = join(home, folder);
  await mkdir(dir, { recursive: true });
  // The default account keeps its identity file next to the folder, at ~/.claude.json.
  const identityPath = folder === ".claude" ? join(home, ".claude.json") : join(dir, ".claude.json");
  await writeFile(identityPath, JSON.stringify({ oauthAccount: identity }, null, 2));
  if (signedIn) await writeFile(join(dir, ".credentials.json"), JSON.stringify(fakeOauth));
  return dir;
}

async function codex(folder, claims) {
  const dir = join(home, folder);
  await mkdir(dir, { recursive: true });
  if (claims) await writeFile(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt(claims), access_token: "fictional", refresh_token: "fictional", account_id: "fictional" } }));
  return dir;
}

await rm(out, { recursive: true, force: true });
await claude(".claude", { emailAddress: "alex@example.com", organizationName: "Personal", planDisplayName: "Max" }, true);
const work = await claude(".claude-work", { emailAddress: "alex@northwind.example", organizationName: "Northwind Labs", organizationType: "claude_enterprise" }, true);
const client = await claude(".claude-client-a", { emailAddress: "alex@contoso.example", organizationName: "Contoso", organizationType: "claude_team" }, true);
const research = await claude(".claude-research", {}, false);
await codex(".codex", { email: "alex@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } });
const codexWork = await codex(".codex-work", { email: "alex@northwind.example", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } });

await mkdir(paseoHome, { recursive: true });
await writeFile(join(paseoHome, "config.json"), JSON.stringify({
  version: 1,
  daemon: { listen: `127.0.0.1:${DAEMON_PORT}`, cors: { allowedOrigins: [`http://127.0.0.1:${WEB_PORT}`] }, relay: { enabled: false } },
  pluginsEnabled: true,
  plugins: { "paseo-baton": { source: "directory", path: pluginDir, enabled: true } },
  agents: {
    providers: {
      "claude-work": { extends: "claude", label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: work } },
      "claude-client-a": { extends: "claude", label: "Claude (Client A)", env: { CLAUDE_CONFIG_DIR: client } },
      "claude-research": { extends: "claude", label: "Claude (Research)", env: { CLAUDE_CONFIG_DIR: research }, enabled: false },
      "codex-work": { extends: "codex", label: "Codex (Work)", env: { CODEX_HOME: codexWork } },
    },
  },
}, null, 2));
console.log(JSON.stringify({ home, paseoHome, daemonPort: DAEMON_PORT, webPort: WEB_PORT }));
