# Paseo Accounts: design

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

## Usage (0.2)

Register a usage source that, in global scope, discovers every non-default
enabled account. Fetching ports the built-in Claude and Codex usage logic
(Paseo builtin plugins, Apache-2.0, with attribution). Per-session usage
already works natively, so 0.1 does not depend on this.

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

## Out of scope for 0.1

Cursor, sharing settings, skills or MCP between accounts, deleting account
folders, and automatic account rotation.

## Release checklist (Kevin, 2026-11-22)

- Screenshots before finalising and publishing: README and directory listing.
  Render the real current components with synthetic, schema-valid fixtures
  (fictional accounts, never real emails or orgs), captured via CDP or
  Playwright in an ephemeral profile. Inspect every image. See
  `lessons-paseo-plugins.md` § Portable state and public demos.
- README manual setup steps for Claude and Codex, in POSIX and PowerShell forms.
- CI green on macOS, Linux and Windows.
