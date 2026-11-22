# Vendored: Paseo's Claude and Codex usage sources

These files are copied unmodified from [Paseo](https://github.com/getpaseo/paseo) at tag `v0.16.2`:

| Here | Upstream |
| --- | --- |
| `claude/server/usage.ts`, `claude/server/stores.ts`, `claude/shared/input.ts`, `claude/icon.svg` | `plugins/claude-usage-source/…` |
| `codex/server/usage.ts`, `codex/server/stores.ts`, `codex/shared/input.ts`, `codex/icon.svg` | `plugins/codex-usage-source/…` |

Copyright (c) 2025-present Mohamed Boudra. Licensed under the Apache License, Version 2.0; see
[LICENSE](LICENSE), Paseo's own license file. Accounts calls them from `server/usage.ts` with each
extra account's folder, so its Usage page cards come from exactly the same lookups and requests as
Paseo's built-in Claude and Codex cards.

To update, copy the same files from a newer tag and run the tests.
