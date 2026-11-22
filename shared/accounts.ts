import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The CLIs this plugin manages. Each kind has a default account and any number of extra ones. */
export const KINDS = ["claude", "codex"] as const;
export type AccountKind = (typeof KINDS)[number];

export const KIND_INFO: Record<AccountKind, { label: string; envVar: string; folderPrefix: string; defaultFolder: string; login: string[] }> = {
  claude: { label: "Claude", envVar: "CLAUDE_CONFIG_DIR", folderPrefix: ".claude-", defaultFolder: ".claude", login: ["claude", "auth", "login"] },
  codex: { label: "Codex", envVar: "CODEX_HOME", folderPrefix: ".codex-", defaultFolder: ".codex", login: ["codex", "login"] },
};

/** Slugs become part of a Paseo provider id (`^[a-z][a-z0-9-]*$`) and a folder name, so they stay plain. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Turns a user-typed name ("Work 2", "Côté perso") into a slug, or null when nothing usable is left. */
export function slugify(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
    .replace(/-+$/g, "");
  return SLUG_PATTERN.test(slug) ? slug : null;
}

export function accountId(kind: AccountKind, slug: string): string {
  return `${kind}-${slug}`;
}

export function accountLabel(kind: AccountKind, name: string): string {
  return `${KIND_INFO[kind].label} (${name.trim()})`;
}

/** Joins with the platform's separator without importing node:path, so the client can use it too. */
export function joinHome(home: string, folder: string, platform: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  return home.endsWith(sep) || home.endsWith("/") ? `${home}${folder}` : `${home}${sep}${folder}`;
}

export type SignInCommand = { shell: "posix" | "powershell" | "cmd"; text: string };

/**
 * Commands that sign one account in, for people to copy. Paths come from `os.homedir()` plus a
 * validated slug, but are still quoted for each shell.
 *
 * `home` is null for a default account. Its variable must stay unset: Claude keys its macOS
 * Keychain item to CLAUDE_CONFIG_DIR, so setting it to `~/.claude` would sign in a separate login.
 */
export function signInCommands(kind: AccountKind, home: string | null): SignInCommand[] {
  const { envVar, login } = KIND_INFO[kind];
  if (home === null) return [{ shell: "posix", text: login.join(" ") }, { shell: "powershell", text: login.join(" ") }];
  const posixQuoted = `'${home.replace(/'/g, `'\\''`)}'`;
  const psQuoted = `'${home.replace(/'/g, "''")}'`;
  return [
    { shell: "posix", text: `mkdir -p ${posixQuoted} && ${envVar}=${posixQuoted} ${login.join(" ")}` },
    { shell: "powershell", text: `New-Item -ItemType Directory -Force -Path ${psQuoted} | Out-Null; $env:${envVar} = ${psQuoted}; ${login.join(" ")}` },
  ];
}

/**
 * argv for a Paseo terminal, which takes a command and arguments but no environment. `env` sets the
 * variable on macOS and Linux without depending on a shell; Windows goes through cmd.exe because
 * the CLIs may be .cmd shims that only cmd.exe can start.
 */
export function signInTerminalArgv(kind: AccountKind, home: string | null, platform: string): { command: string; args: string[] } {
  const { envVar, login } = KIND_INFO[kind];
  if (home === null) {
    return platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", login.join(" ")] } : { command: login[0]!, args: login.slice(1) };
  }
  if (platform === "win32") {
    if (/["%^&|<>]/.test(home)) throw new Error("This folder path can't be passed to cmd.exe safely; run the sign-in command yourself");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `set "${envVar}=${home}"&& ${login.join(" ")}`] };
  }
  return { command: "env", args: [`${envVar}=${home}`, ...login] };
}

const kind = z.enum(KINDS);

export const accountStatus = z.object({
  state: z.enum(["signed-in", "signed-out", "expired", "unknown"]),
  /** Email of the signed-in user, when the CLI recorded one. */
  email: z.string().optional(),
  organization: z.string().optional(),
  plan: z.string().optional(),
  /** ISO time the stored login expires, when known. */
  expiresAt: z.string().optional(),
  detail: z.string().optional(),
});
export type AccountStatus = z.infer<typeof accountStatus>;

export const account = z.object({
  id: z.string(),
  kind,
  label: z.string(),
  home: z.string(),
  isDefault: z.boolean(),
  /** Created by this plugin (`claude-<slug>` / `codex-<slug>` with the env var set). Others are shown read-only. */
  managed: z.boolean(),
  enabled: z.boolean(),
  order: z.number().optional(),
  status: accountStatus,
  signIn: z.array(z.object({ shell: z.enum(["posix", "powershell", "cmd"]), text: z.string() })),
});
export type Account = z.infer<typeof account>;

export const listRpc = defineRpc({
  name: "accounts.list",
  input: z.object({ refresh: z.boolean().default(false) }),
  output: z.object({ accounts: z.array(account), platform: z.string() }),
});

export const addRpc = defineRpc({
  name: "accounts.add",
  input: z.object({ kind, name: z.string().trim().min(1).max(40) }),
  output: z.object({ account }),
});

export const updateRpc = defineRpc({
  name: "accounts.update",
  input: z.object({ id: z.string().min(1), label: z.string().trim().min(1).max(60).optional(), enabled: z.boolean().optional() }),
  output: z.object({ ok: z.literal(true) }),
});

export const removeRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.literal(true), home: z.string() }),
});

export const workspacesRpc = defineRpc({
  name: "accounts.workspaces",
  input: z.object({}),
  output: z.object({ workspaces: z.array(z.object({ id: z.string(), name: z.string() })) }),
});

export const signInRpc = defineRpc({
  name: "accounts.sign-in",
  input: z.object({ id: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ terminalId: z.string() }),
});
