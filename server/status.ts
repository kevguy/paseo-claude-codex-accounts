/// <reference types="node" />
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountKind, AccountStatus } from "../shared/accounts";

/**
 * Login status read from each CLI's own files. Nothing here returns, logs or keeps a token: only
 * identity fields (email, organisation, plan) and whether a credential exists.
 */

export interface StatusEnv {
  platform: NodeJS.Platform;
  /** The user's home folder (`os.homedir()`), used for the default Claude identity file. */
  homedir: string;
  /** Checks whether a macOS Keychain item exists without reading its secret. Injected for tests. */
  keychainHas?: (service: string) => Promise<boolean | null>;
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Claude's Keychain item for a config folder: the default name, plus the first 8 hex characters of
 * sha256(NFC folder path) when CLAUDE_CONFIG_DIR is set. Matches Paseo's built-in Claude usage
 * source and the item Claude Code 2.1.x creates.
 */
export function claudeKeychainService(configDir: string | null): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE;
  const hash = createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/** `security find-generic-password` without `-w` prints attributes only; exit status says whether it exists. */
export function macKeychainHas(service: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", service], { timeout: 5000 }, (error) => {
      if (!error) return resolve(true);
      // execFile puts the exit status in `code` (a number); 44 means the item wasn't found.
      const code: unknown = (error as { code?: unknown }).code;
      resolve(code === 44 ? false : null);
    });
  });
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @param configDir the account's CLAUDE_CONFIG_DIR, or null for the default account (whose identity
 * file is `~/.claude.json` and credentials `~/.claude/.credentials.json`).
 */
export async function claudeStatus(configDir: string | null, env: StatusEnv): Promise<AccountStatus> {
  try {
    const identityPath = configDir ? join(configDir, ".claude.json") : join(env.homedir, ".claude.json");
    const credentialsPath = join(configDir ?? join(env.homedir, ".claude"), ".credentials.json");
    const identity = record(record(await readJson(identityPath))?.oauthAccount);
    const credentials = record(await readJson(credentialsPath));
    const oauth = record(credentials?.claudeAiOauth);
    let hasCredential = Boolean(oauth);
    if (!hasCredential && env.platform === "darwin") {
      const has = await (env.keychainHas ?? macKeychainHas)(claudeKeychainService(configDir));
      if (has === null) return { state: "unknown", detail: "Couldn't check the macOS Keychain" };
      hasCredential = has;
    }
    const who = {
      ...(text(identity?.emailAddress) ? { email: text(identity?.emailAddress) } : {}),
      ...(text(identity?.organizationName) ? { organization: text(identity?.organizationName) } : {}),
      ...(planLabel(identity) ? { plan: planLabel(identity) } : {}),
    };
    if (!hasCredential) return { state: "signed-out" };
    return { state: "signed-in", ...who };
  } catch (error) {
    return { state: "unknown", detail: `Couldn't read this account's files: ${(error as Error).message}` };
  }
}

function planLabel(identity: Record<string, unknown> | undefined): string | undefined {
  const display = text(identity?.planDisplayName);
  if (display) return display;
  const type = text(identity?.organizationType);
  if (!type) return undefined;
  return type.replace(/^claude_/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Payload of a JWT, without verifying it: used only to show who the stored login belongs to. */
export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return record(JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

export async function codexStatus(codexHome: string, env: StatusEnv): Promise<AccountStatus> {
  try {
    const auth = record(await readJson(join(codexHome, "auth.json")));
    if (!auth) return { state: "signed-out" };
    const tokens = record(auth.tokens);
    if (tokens && (tokens.id_token || tokens.access_token)) {
      const claims = jwtClaims(tokens.id_token);
      const openai = record(claims?.["https://api.openai.com/auth"]);
      const plan = text(openai?.chatgpt_plan_type);
      return {
        state: "signed-in",
        ...(text(claims?.email) ? { email: text(claims?.email) } : {}),
        ...(plan ? { plan: `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` } : {}),
      };
    }
    if (text(auth.OPENAI_API_KEY)) return { state: "signed-in", plan: "API key" };
    return { state: "signed-out" };
  } catch (error) {
    return { state: "unknown", detail: `Couldn't read this account's files: ${(error as Error).message}` };
  }
}

export function readStatus(kind: AccountKind, home: string, isDefaultHome: boolean, env: StatusEnv): Promise<AccountStatus> {
  return kind === "claude" ? claudeStatus(isDefaultHome ? null : home, env) : codexStatus(home, env);
}
