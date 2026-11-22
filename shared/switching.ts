import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Switching which account a chat runs on.
 *
 * Every account is a folder with its own login. A chat keeps its provider (and with it its
 * settings and transcript); the plugin only changes which login the CLI uses, by pointing Claude Code's
 * CLAUDE_SECURESTORAGE_CONFIG_DIR at another account's folder when the session opens. Reloading the
 * agent applies it, and the conversation continues.
 */

/** Agent metadata keys. Paseo stores them with the agent and never reads them itself. */
export const META_ACCOUNT = "paseo-claude-codex-accounts.account";
/** Written by the server when a session opens, so the message box knows which agent it belongs to. */
export const META_AGENT = "paseo-claude-codex-accounts.agent";
/**
 * An agent label naming the account to start on, for scripts and orchestrators:
 * `paseo run --label account=claude-work ...` or `paseo import --label account=...`.
 */
export const LABEL_ACCOUNT = "account";
/** Draft-only: "auto" asks for the account with the most headroom when the chat is created. */
export const AUTO_ACCOUNT = "auto";

export const ruleSchema = z.object({ pattern: z.string().min(1).max(1024), accountId: z.string().min(1).max(64) });
export type Rule = z.infer<typeof ruleSchema>;

export const switchingSettings = defineSettings({
  id: "switching",
  scope: "host",
  // Version 2 made automatic switching opt-in. Saving any setting under version 1 stored it as on,
  // so the migration turns it off once; people who want it turn it back on.
  version: 2,
  schema: z.object({
    /** Folder rules for new chats, e.g. ~/work/** → Claude (Work). */
    rules: z.array(ruleSchema).max(200).default([]),
    /**
     * Move a chat to another account when its account hits a usage limit. Off by default: it can carry a
     * conversation on under another account or organisation, including a chat a folder rule placed.
     */
    autoSwitch: z.boolean().default(false),
    /** Also move a chat, between turns, once its account passes this share of a limit. 100 turns it off. */
    switchBeforePercent: z.number().int().min(50).max(100).default(95),
    /** After an automatic move caused by a limit, tell the chat to carry on. */
    continueAfterSwitch: z.boolean().default(true),
    /** When every account is at a limit, carry on by itself once one resets (unless you've written to the chat since). */
    waitForReset: z.boolean().default(false),
    /** Give agents tools to list accounts and move chats, for orchestrators. */
    agentTools: z.boolean().default(false),
    /** New chats with no rule and no explicit choice: keep the picker's provider, or pick the account with most headroom. */
    newChats: z.enum(["picker", "most-headroom"]).default("picker"),
  }),
  migrate: (values, fromVersion) => migrateSwitching(values, fromVersion),
});

export function migrateSwitching(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || !values || typeof values !== "object") return values;
  return { ...(values as Record<string, unknown>), autoSwitch: false };
}
export type SwitchingOptions = z.infer<typeof switchingSettings.schema>;
export const DEFAULT_SETTINGS: SwitchingOptions = switchingSettings.schema.parse({});

const choiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().optional(),
  /** Organisation and plan, so a personal plan and a company seat with one email look different. */
  detail: z.string().optional(),
  state: z.enum(["signed-in", "signed-out", "unknown"]),
  /** Highest share used across the account's limits (5-hour, weekly, ...), when known. */
  usedPct: z.number().nullable(),
  /** Short summary such as "5h 42% · wk 18%". */
  usage: z.string().optional(),
  /** ISO time a limit this account hit resets, when the plugin saw it hit one. */
  limitedUntil: z.string().optional(),
});
export type AccountChoice = z.infer<typeof choiceSchema>;

export const chooserRpc = defineRpc({
  name: "accounts.chooser",
  input: z.object({ agentId: z.string().optional(), provider: z.string().optional() }),
  output: z.object({
    kind: z.enum(["claude", "codex"]).nullable(),
    /** The account the agent runs on now (null for drafts). */
    current: z.string().nullable(),
    /** Accounts of the same kind. */
    choices: z.array(choiceSchema),
    /** Claude chats switch in place. Codex chats can't: Codex encrypts each conversation per account. */
    inPlace: z.boolean(),
  }),
});

export const switchRpc = defineRpc({
  name: "accounts.switch",
  input: z.object({ agentId: z.string().min(1), accountId: z.string().min(1) }),
  output: z.object({ ok: z.literal(true), label: z.string(), deferred: z.boolean() }),
});

export const SWITCH_ROW_KIND = "account-switch";
export const switchRowSchema = z.object({
  from: z.string().nullable(),
  /** Null when the plugin couldn't move the chat ("stuck"). */
  to: z.string().nullable(),
  reason: z.enum(["manual", "limit", "headroom", "rule", "stuck"]),
  detail: z.string().optional(),
});
export type SwitchRow = z.infer<typeof switchRowSchema>;

const signInView = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting"), kind: z.enum(["claude", "codex"]), url: z.string(), localUrl: z.string().optional(), code: z.string().optional(), needsCode: z.boolean() }),
  /** `warning` when the folder now holds a different login than before, so chats using it change who they run as. */
  z.object({ state: z.literal("done"), email: z.string().optional(), warning: z.string().optional() }),
  z.object({ state: z.literal("failed"), error: z.string() }),
]);
export type SignInView = z.infer<typeof signInView>;

/** Starts signing an account in from inside Paseo. "code" works from any device; "browser" only on the host. */
export const signInStartRpc = defineRpc({
  name: "accounts.signin.start",
  input: z.object({ accountId: z.string().min(1), method: z.enum(["browser", "code"]), email: z.string().max(254).optional() }),
  output: z.object({ sessionId: z.string(), view: signInView }),
});
export const signInViewRpc = defineRpc({
  name: "accounts.signin.view",
  input: z.object({ sessionId: z.string().min(1) }),
  output: signInView,
});
export const signInCodeRpc = defineRpc({
  name: "accounts.signin.code",
  input: z.object({ sessionId: z.string().min(1), code: z.string().min(1).max(4096) }),
  output: z.object({ ok: z.boolean(), retry: z.boolean(), error: z.string().optional() }),
});
export const signInCancelRpc = defineRpc({
  name: "accounts.signin.cancel",
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
