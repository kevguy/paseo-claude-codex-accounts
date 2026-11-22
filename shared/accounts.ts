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

/** The part of `path` below the home folder (`""` for the home folder itself), or null when it isn't under it. */
export function homeRelative(path: string, homedir: string, platform: string): string | null {
  const win = platform === "win32";
  const trim = (value: string) => value.replace(win ? /[\\/]+$/ : /\/+$/, "");
  const home = trim(homedir), full = trim(path);
  if (!home) return null;
  // Compare the prefix without changing its length (lower-casing "İ" adds a character), then slice
  // the original path at that same length.
  const same = (a: string, b: string) => (win ? a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase() : a === b);
  if (full.length === home.length) return same(full, home) ? "" : null;
  const separator = full[home.length];
  const isSeparator = separator === "/" || (win && separator === "\\");
  return isSeparator && same(full.slice(0, home.length), home) ? full.slice(home.length + 1) : null;
}

/** Shortens a path under the home folder to `~/…` (or `~\\…` on Windows) for display. */
export function displayPath(path: string, homedir: string, platform: string): string {
  const rest = homeRelative(path, homedir, platform);
  if (rest === null) return path;
  return rest ? `~${platform === "win32" ? "\\" : "/"}${rest}` : "~";
}

export type SignInCommand = { shell: "posix" | "powershell"; text: string };

/** Single-quotes a value for POSIX shells. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quotes a value for PowerShell, which also treats the typographic quotes ‘ ’ ‚ ‛ as quotes. */
export function powershellQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`;
}

/**
 * Commands that sign one account in, for people to copy. Paths come from `os.homedir()` plus a
 * validated slug, but are still quoted for each shell. The PowerShell form clears the variable
 * afterwards, even when the login is cancelled, so later commands in that window use the default
 * account again.
 *
 * `home` is null for a default account. Its variable must stay unset: Claude keys its macOS
 * Keychain item to CLAUDE_CONFIG_DIR, so setting it to `~/.claude` would sign in a separate login.
 */
export function signInCommands(kind: AccountKind, home: string | null, place?: { homedir: string; platform: string }): SignInCommand[] {
  const { envVar, login } = KIND_INFO[kind];
  if (home === null) return [{ shell: "posix", text: login.join(" ") }, { shell: "powershell", text: login.join(" ") }];
  // A folder under the home folder is written relative to it, which is shorter and works for anyone
  // who copies it. Only plain names qualify, so double quotes stay safe. PowerShell uses
  // $env:USERPROFILE, the folder Node's os.homedir() returns on Windows; its $HOME can differ.
  const rest = place ? homeRelative(home, place.homedir, place.platform) : null;
  const plain = rest !== null && /^[A-Za-z0-9._-]+([\\/][A-Za-z0-9._-]+)*$/.test(rest);
  const posix = plain ? `"$HOME/${rest.replace(/\\/g, "/")}"` : posixQuote(home);
  const ps = plain ? `"$env:USERPROFILE\\${rest.replace(/\//g, "\\")}"` : powershellQuote(home);
  return [
    { shell: "posix", text: `mkdir -p ${posix} && ${envVar}=${posix} ${login.join(" ")}` },
    { shell: "powershell", text: `New-Item -ItemType Directory -Force -Path ${ps} | Out-Null; $env:${envVar} = ${ps}; try { ${login.join(" ")} } finally { Remove-Item Env:${envVar} }` },
  ];
}

/**
 * Runs a PowerShell script as `powershell.exe -EncodedCommand`. The script travels as base64 of
 * UTF-16LE, so no quoting layer between Paseo's terminal and PowerShell can change it, whatever
 * the folder path contains.
 */
export function powershellArgv(script: string): { command: string; args: string[] } {
  const bytes: number[] = [];
  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i);
    bytes.push(unit & 0xff, unit >> 8);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", btoa(binary)] };
}

/**
 * argv for a Paseo terminal, which takes a command and arguments but no environment. `env` sets the
 * variable on macOS and Linux without depending on a shell. Windows uses PowerShell, which starts
 * the CLIs whether they are .exe files or npm .cmd/.ps1 shims.
 */
export function signInTerminalArgv(kind: AccountKind, home: string | null, platform: string): { command: string; args: string[] } {
  const { envVar, login } = KIND_INFO[kind];
  if (platform === "win32") {
    return powershellArgv(home === null ? login.join(" ") : `$env:${envVar} = ${powershellQuote(home)}; ${login.join(" ")}`);
  }
  return home === null ? { command: login[0]!, args: login.slice(1) } : { command: "env", args: [`${envVar}=${home}`, ...login] };
}

const kind = z.enum(KINDS);

export const accountStatus = z.object({
  state: z.enum(["signed-in", "signed-out", "unknown"]),
  /** Email of the signed-in user, when the CLI recorded one. */
  email: z.string().optional(),
  organization: z.string().optional(),
  plan: z.string().optional(),
  detail: z.string().optional(),
});
export type AccountStatus = z.infer<typeof accountStatus>;

export const account = z.object({
  id: z.string(),
  kind,
  label: z.string(),
  home: z.string(),
  /** `home` shortened to start with `~` when it sits under the user's home folder. */
  displayHome: z.string(),
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
