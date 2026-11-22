# Claude & Codex Accounts: design

Status: draft for 0.1, 2026-11-22. Bead `pad-5xc`.

## Goal

Run any number of Claude and Codex accounts side by side in Paseo: add, sign
in, check, hide and remove them from one screen, on macOS, Linux and Windows.
Nothing assumes "one default plus one extra"; the tenth account works like the
second.

## What Paseo already does (verified in Paseo 0.16.2)

- **Custom providers.** An `agents.providers.<id>` entry with `extends:
  "claude" | "codex"`, a `label` and an `env` becomes its own provider row,
  backed by the full built-in client. Its environment carries
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Source:
  `@getpaseo/server/.../agent/provider-registry.js`.
- **Config API.** Plugin handlers get `paseo.config.get/patch`. A patch's
  `providers.<id>` is parsed with `ProviderOverrideSchema`, so `extends`,
  `label`, `env`, `enabled` and `order` persist. `removeProviders: [id]`
  deletes an entry. The daemon validates, saves and applies the change.
  Source: `daemon-config-store.js` (`applyMutableProviderConfigToOverrides`).
  Proven 2026-11-22: a patch from a Node client added `claude-ptest`; `paseo provider
  ls` showed it at once with no reload; `removeProviders` restored the config
  byte-identical. Paseo's availability check creates the config folder
  (`.claude.json`, `plugins/`, `sessions/`, `backups/`) as soon as the entry exists.
  Also proven 2026-11-22 against an isolated 0.16.2 daemon: a partial patch
  (`{ enabled }` or `{ label }` alone) merges into the entry and keeps
  `extends` and `env`.
- **Per-session usage.** The Claude and Codex agents report
  `provider: "claude" | "codex"` with their own harness environment, so the
  built-in usage sources already pick the right account (including the
  per-directory Keychain item) for a running session. The global view (no
  session open) only knows the default account.
- **Terminals.** `paseo.terminals.create({workspaceId, command, args})` has
  no env option.

## Account model

An account is one provider entry of kind `claude` or `codex`:

| Field | Source |
| --- | --- |
| `id` | provider id: `claude`, `codex` (defaults) or `claude-<slug>` / `codex-<slug>` |
| `kind` | `claude` or `codex` (`extends`, or the built-in id) |
| `label` | entry label, e.g. "Claude (work)" |
| `home` | `env.CLAUDE_CONFIG_DIR` / `env.CODEX_HOME`, or the default folder |
| `enabled`, `order` | entry fields |
| `managed` | true when this plugin created it (other custom entries are shown read-only) |

New account folders are `join(os.homedir(), ".claude-<slug>")` and
`join(os.homedir(), ".codex-<slug>")`. Slugs match `[a-z0-9][a-z0-9-]{0,30}`,
so ids satisfy Paseo's `^[a-z][a-z0-9-]*$` and paths need no quoting.

## Status, without spawning CLIs

Status is read from files, so no binary needs resolving on any OS:

- **Claude:** `<home>/.claude.json` → `oauthAccount` (email, organisation,
  plan) for identity. Credentials: on macOS, the Keychain item
  `Claude Code-credentials` plus `-<first 8 hex of sha256(NFC(home))>` for
  non-default homes; it's checked for existence only and never read. On
  Linux and Windows, `<home>/.credentials.json`: signed in when it has a
  `claudeAiOauth` entry. The file can also hold MCP server logins, so it is
  parsed, but only that entry's presence is kept. Its expiry isn't used,
  because the CLI refreshes the access token on its own.
- **Codex:** `<home>/auth.json`: the auth mode and the identity claims of the
  id token (email, plan). The token itself is never logged or returned.
- Errors name the file but never quote it: a bad file gives "isn't valid
  JSON" rather than JSON.parse's message, which repeats the file's start.
- Results are cached for 60 s, with at most 3 accounts read at once.
  Hidden accounts are read too, so the list shows who they belong to.

## Where it shows

A Settings screen (Settings → Plugins → Accounts), a workspace panel (a
workspace's + menu; sign-in terminals open in that workspace), and a Command
Center item that opens the Settings screen. No sidebar item.

## Sign-in

1. "Sign in" opens a Paseo terminal in the current workspace:
   - macOS/Linux: `env CLAUDE_CONFIG_DIR=<home> claude auth login`, or
     `env CODEX_HOME=<home> codex login`;
   - Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand`
     with `$env:CLAUDE_CONFIG_DIR = '<home>'; claude auth login`. The script
     goes as base64 of UTF-16LE, so no quoting layer can change it. A cmd.exe
     command line was dropped: Node re-escapes inner quotes as `\"`, which
     cmd.exe doesn't understand. CI on Windows runs the encoded script and
     checks the variable for a path with spaces, quotes, `&`, `%` and `^`.
2. The panel always shows the same commands for copying, in POSIX and
   PowerShell forms, as the fallback when no workspace is open.
3. Status refreshes when the user presses Refresh. The plugin can't see when
   the sign-in terminal finishes.

## Usage

Paseo's built-in usage sources list only the default login in global scope
(the Usage page), and a running agent's own login in its session. Accounts
registers two more sources, `accounts-claude` ("Claude accounts") and
`accounts-codex` ("Codex accounts"):
- `discover(global)` reads `agents.providers` from
  `$PASEO_HOME/config.json` (the daemon passes `PASEO_HOME` to plugin
  processes; default `~/.paseo`), because a usage source gets no Paseo API.
  For each non-default account it calls Paseo's own `discover` with a session
  scope whose env holds only `HOME`, `USERPROFILE`, `USER` and that account's
  folder variable. A session scope looks at exactly that folder, so the
  default login and other tools' stores (Pi, OMP, OpenCode) aren't listed
  twice. Labels become `Claude (Work) · <email>`. Keys are prefixed with the
  provider id, so each folder gets its own card: the vendored Codex key is the
  ChatGPT workspace, which two seats of one Team workspace would share.
- `config.json` is found the way the daemon finds it (`PASEO_HOME`, else
  `~/.paseo`, with `~` and `~/` expanded). Read and parse errors never quote the
  file, whose provider env entries can hold API keys.
- Paseo doesn't merge cards across sources, so while an agent runs on an extra
  account it can show on both the built-in card and "Claude accounts".
- `discover(session)` returns nothing: the built-in source already reports a
  running agent's own login.
- `fetch` is Paseo's own `fetchUsage`.
- The code is vendored unmodified from Paseo v0.16.2 under `server/vendor`
  (Paseo only loads plugin modules from `client/`, `server/` and `shared/`),
  with Paseo's Apache-2.0 license. The files match the upstream tag byte for
  byte.
- Verified 2026-11-22: on an isolated daemon with fictional accounts it lists
  each signed-in extra account and skips signed-out ones; on the live daemon
  the real work account reports its plan and details.

## Scale (N accounts)

- List, status and usage are all per-account loops with bounded concurrency
  and caching. There are no fixed slots or per-name branches.
- Hiding (`enabled: false`) keeps an account but removes it from the model
  picker. `order` keeps the picker manageable with many rows.
- Removing an account deletes the provider entry only. The folder (and its
  login) stays until the user deletes it; the UI shows its path.
- Unique labels and ids are enforced on add and rename. Config changes run one
  at a time, so two quick adds can't both pass the check.

## Cross-platform

macOS, Linux and Windows are all supported:
- paths come from `os.homedir()` and `path.join`;
- no shell-specific syntax except the explicit `env` / PowerShell wrappers above;
- home paths are shown as `~/…` (`~\…` on Windows) when under the home folder;
- the CI matrix covers all three systems.

The README documents the manual steps for each platform (POSIX shell and
PowerShell).

## Switching a chat between accounts (1.0)

Verified on Claude Code 2.1.328 and Paseo 0.16.2, 2026-11-22.

- **Login-only switch.** Claude Code reads its login from `CLAUDE_SECURESTORAGE_CONFIG_DIR` when
  set (macOS Keychain service `Claude Code-credentials-<sha256(NFC dir)[:8]>`; elsewhere
  `<dir>/.credentials.json`), and everything else from `CLAUDE_CONFIG_DIR`. Checked with
  `claude auth status`: default config + the work folder's login reports the work subscription.
  An **empty** value selects the default login (the unsuffixed Keychain item); pointing it at
  `~/.claude` finds nothing on macOS, so the plugin uses `""` for the default account.
- **Applying it.** `agent.open.before` may change only `env`, `tools` and `mcpServers`; its env
  overrides the provider's. The plugin stores the account in agent metadata
  (`paseo-claude-codex-accounts.account`) and sets
  the variable on every open (create, resume, refresh, import, history). `agents.ref(id).reload()`
  reopens with reason `refresh`. Live test: a Haiku chat moved personal → work → personal; inside
  it `claude auth status` went `max` → `enterprise` → `max`, and it kept its conversation.
- **Paseo can't change a running agent's provider** (`agent.config.apply` has no provider), so a
  switched chat keeps its provider label; the plugin's message-box control shows the real account.
- **Limits.** Paseo passes plugins only the failed turn's text (Claude's `rate_limit_event` and
  Codex's `codexErrorInfo` are not forwarded). The plugin matches the CLI wording (patterns adapted from
  ZeroSub, MIT) and, when the text isn't recognised, reads the account's usage; a window at 100%
  counts as a limit.
- **Codex** encrypts a conversation per ChatGPT account, so Codex chats choose their account at
  creation (`agent.create.before` may change `config.provider`) and don't move. A Codex
  chat's account can't come from a label: the create hook doesn't see labels, and the open hook
  can't change the provider, so scripts pass `--provider codex-<name>` instead.
- **Sign-in in the app.** Claude: `claude auth login --claudeai` with `BROWSER` pointing at a script
  that records the host-only link; the CLI also prints a link whose page shows `code#state`, which
  is written to the CLI's stdin. The CLI exits on a wrong code. Codex: `codex app-server`,
  `account/login/start` with `chatgpt` or `chatgptDeviceCode`; its messages carry no `"jsonrpc"`
  field.
- **Timeline notes** need a kind of lowercase letters, digits and dashes (`account-switch`).
- **Naming.** Renamed from "Baton" before release, because the directory already lists a dozen
  account plugins and people search for "Claude", "Codex" and "accounts".
- **Plugin build** rejects server imports of `@getpaseo/client`, even type-only ones.

## Out of scope

Cursor and other providers, moving Codex conversations between accounts, deleting account folders,
and keeping "wait for the reset" across a Paseo restart.

## Release checklist (Kevin, 2026-11-22)

- Screenshots before finalising and publishing: README and directory listing.
  Render the real current components with synthetic, schema-valid fixtures
  (fictional accounts, never real emails or orgs), captured via CDP or
  Playwright in an ephemeral profile. Inspect every image. See
  `lessons-paseo-plugins.md` § Portable state and public demos.
- README manual setup steps for Claude and Codex, in POSIX and PowerShell forms.
- CI green on macOS, Linux and Windows.
