# Third-party notices

## ZeroSub

`server/limits.ts` adapts the usage-limit message patterns from
[ZeroSub](https://github.com/kapybara-org/zerosub) (`server/limits.ts`), under the MIT License.
This plugin's in-app sign-in (`server/claude-login.ts`, `server/codex-login.ts`) is written separately but
follows the approach ZeroSub showed: capturing Claude's browser link and taking its code back, and
Codex's app-server sign-in.

```text
MIT License

Copyright (c) 2026 Kapybara

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Paseo

`server/vendor/paseo-usage` is Paseo's usage code, unmodified, under the Apache License 2.0. See
[server/vendor/paseo-usage/README.md](server/vendor/paseo-usage/README.md) and its `LICENSE`.
