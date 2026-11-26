// Mounts the real sign-in and Accounts components and checks what happens to replies that arrive
// after the user has left: closed the screen, or moved it to another host. Paseo evaluates each host's
// plugin bundle separately, so a host switch mounts a new screen; `show` does the same with a key.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const stubs: Record<string, string> = {
  "react-native": "react-native",
  "@getpaseo/plugin/client": "plugin-client",
  "@getpaseo/plugin/client/ui": "plugin-client-ui",
};
const built = await build({
  stdin: {
    contents: `export { SignInHere } from "./client/signin"; export { AccountsScreen } from "./client/accounts";
      export { HostRpc, opened } from "@getpaseo/plugin/client"; export { toasts } from "@getpaseo/plugin/client/ui";`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", write: false, logLevel: "error", jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react-test-renderer", "@tanstack/react-query"],
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client(\/ui)?)$/ }, (args) => ({ path: join(root, "tests", "stubs", `${stubs[args.path]}.js`) }));
    },
  }],
});
const require = createRequire(join(root, "package.json"));
const loaded = { exports: {} as any };
new Function("require", "module", "exports", built.outputFiles[0]!.text)(require, loaded, loaded.exports);
const { SignInHere, AccountsScreen, HostRpc, opened, toasts } = loaded.exports;
const { createElement, act } = require("react");
const renderer = require("react-test-renderer");
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-test-renderer 19 says it is deprecated each time a tree is created.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (!String(args[0]).includes("react-test-renderer is deprecated")) consoleError(...args);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const theme = { colors: new Proxy({}, { get: () => "#000" }) };
const claude = {
  id: "claude-work", kind: "claude", label: "Claude (Work)", home: "/home/me/.claude-work", displayHome: "~/.claude-work",
  isDefault: false, managed: true, enabled: true, status: { state: "signed-out" }, signIn: [{ shell: "posix", text: "claude /login" }],
};
const waiting = { state: "waiting", kind: "claude", url: "https://claude.ai/oauth/authorize?x=1", needsCode: true };

type Call = { host: string; name: string; input: any };
let open: { close(): Promise<void> } | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/** A screen on one client. `calls` holds every RPC each host received; `reply` answers one method. */
function screen(Component: unknown, props: Record<string, unknown>) {
  opened.length = 0;
  toasts.length = 0;
  const calls: Call[] = [];
  const replies: Record<string, (input: any) => unknown> = {};
  // Each host has its own RPC function and query cache, as each Paseo installation does.
  const hosts: Record<string, { call(name: string, input: any): Promise<unknown>; client: any }> = {};
  const hostOf = (host: string) =>
    (hosts[host] ??= {
      call: async (name, input) => {
        calls.push({ host, name, input });
        return replies[name]?.(input) ?? {};
      },
      client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    });
  let tree: any = null;
  const view = (host: string) => {
    const { call, client } = hostOf(host);
    const surface = createElement(Component, { key: host, theme, host: { id: host, label: host }, ...props });
    return createElement(QueryClientProvider, { client }, createElement(HostRpc, { call }, surface));
  };
  const settle = (ms = 0) => act(() => sleep(ms));
  const rows = (label: string) => tree.root.findAll((node: any) => node.type === "SettingsAction" && node.props.label === label);
  const s = {
    calls,
    replies,
    of: (name: string) => calls.filter((c) => c.name === name).map(({ host, input }) => ({ host, ...input })),
    settle,
    rows,
    async show(host: string) {
      await act(async () => {
        if (tree) tree.update(view(host));
        else tree = renderer.create(view(host));
      });
      await settle(10);
    },
    async press(label: string) {
      const [row] = rows(label);
      assert.ok(row, `no "${label}" row`);
      await act(async () => void row.props.onPress());
      await settle(10);
    },
    async close() {
      if (tree) await act(async () => tree.unmount());
      tree = null;
    },
  };
  open = s;
  return s;
}

/** A reply the test sends when it chooses. */
function later<T>() {
  let send!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (send = resolve));
  return { promise, send: (value: T) => act(async () => send(value)) };
}

test("a sign-in that starts after the screen closed is cancelled on its host, and opens nothing", async () => {
  const s = screen(SignInHere, { account: claude, onDone() {} });
  const started = later<unknown>();
  s.replies["accounts.signin.start"] = () => started.promise;
  await s.show("A");
  await s.press("Sign in here");
  await s.close();
  await started.send({ sessionId: "s1", view: waiting });
  await s.settle(50);
  assert.deepEqual(s.of("accounts.signin.cancel"), [{ host: "A", sessionId: "s1" }]);
  assert.deepEqual(opened, []);
  assert.deepEqual(toasts, []);
});

test("a sign-in that starts after a host switch is cancelled on the first host, not the new one", async () => {
  const s = screen(SignInHere, { account: claude, onDone() {} });
  const started = later<unknown>();
  s.replies["accounts.signin.start"] = () => started.promise;
  await s.show("A");
  await s.press("Sign in here");
  await s.show("B");
  await started.send({ sessionId: "s1", view: waiting });
  await s.settle(50);
  assert.deepEqual(s.of("accounts.signin.cancel"), [{ host: "A", sessionId: "s1" }]);
  assert.deepEqual(s.calls.filter((c) => c.host === "B"), []);
  assert.deepEqual(opened, []);
  // B shows its own, idle sign-in.
  assert.equal(s.rows("Sign in here").length, 1);
});

test("a start that fails after the screen closed shows no error", async () => {
  const s = screen(SignInHere, { account: claude, onDone() {} });
  const started = later<never>();
  s.replies["accounts.signin.start"] = () => started.promise.then(() => Promise.reject(new Error("Couldn't find the claude command")));
  await s.show("A");
  await s.press("Sign in here");
  await s.close();
  await started.send(undefined as never);
  await s.settle(50);
  assert.deepEqual(toasts, []);
});

test("a status reply that arrives after Stop signing in is ignored", async () => {
  let done = 0;
  const s = screen(SignInHere, { account: claude, onDone: () => done++ });
  s.replies["accounts.signin.start"] = () => ({ sessionId: "s1", view: waiting });
  const status = later<unknown>();
  s.replies["accounts.signin.view"] = () => status.promise;
  await s.show("A");
  await s.press("Sign in here");
  await s.settle(2100);
  assert.equal(s.of("accounts.signin.view").length, 1);
  await s.press("Stop signing in");
  await status.send({ state: "done", email: "me@example.com" });
  await s.settle(50);
  assert.deepEqual(toasts, []);
  assert.equal(done, 0);
  assert.deepEqual(s.of("accounts.signin.cancel")[0], { host: "A", sessionId: "s1" });
});

test("a status reply that arrives after the screen closed is ignored", async () => {
  let done = 0;
  const s = screen(SignInHere, { account: claude, onDone: () => done++ });
  s.replies["accounts.signin.start"] = () => ({ sessionId: "s1", view: waiting });
  const status = later<unknown>();
  s.replies["accounts.signin.view"] = () => status.promise;
  await s.show("A");
  await s.press("Sign in here");
  await s.settle(2100);
  await s.close();
  await status.send({ state: "failed", error: "The sign-in expired" });
  await s.settle(50);
  assert.deepEqual(toasts, []);
  assert.equal(done, 0);
  assert.deepEqual(s.of("accounts.signin.cancel"), [{ host: "A", sessionId: "s1" }]);
});

test("a sign-in terminal that opens after the panel closed doesn't navigate", async () => {
  const visits: unknown[] = [];
  const s = screen(AccountsScreen, { workspaceId: "w1", navigation: { openWorkspace: (input: unknown) => visits.push(input) } });
  s.replies["accounts.list"] = () => ({ accounts: [claude], platform: "darwin" });
  const terminal = later<unknown>();
  s.replies["accounts.sign-in"] = () => terminal.promise;
  await s.show("A");
  await s.press("Sign in in a terminal");
  await s.close();
  await terminal.send({ terminalId: "t1" });
  await s.settle(50);
  assert.deepEqual(s.of("accounts.sign-in"), [{ host: "A", id: "claude-work", workspaceId: "w1" }]);
  assert.deepEqual(visits, []);
});

// These already worked and must keep working.
test("while the screen is open, a sign-in opens its page and reports when it's done", async () => {
  let done = 0;
  const s = screen(SignInHere, { account: claude, onDone: () => done++ });
  s.replies["accounts.signin.start"] = () => ({ sessionId: "s1", view: waiting });
  s.replies["accounts.signin.view"] = () => ({ state: "done", email: "me@example.com" });
  await s.show("A");
  await s.press("Sign in here");
  assert.deepEqual(opened, [waiting.url]);
  await s.settle(2100);
  assert.deepEqual(toasts, ["Claude (Work) signed in as me@example.com"]);
  assert.equal(done, 1);
});

test("while the panel is open, a sign-in terminal opens its workspace", async () => {
  const visits: unknown[] = [];
  const s = screen(AccountsScreen, { workspaceId: "w1", navigation: { openWorkspace: (input: unknown) => visits.push(input) } });
  s.replies["accounts.list"] = () => ({ accounts: [claude], platform: "darwin" });
  s.replies["accounts.sign-in"] = () => ({ terminalId: "t1" });
  await s.show("A");
  await s.press("Sign in in a terminal");
  assert.deepEqual(visits, [{ workspaceId: "w1", serverId: "A" }]);
});
