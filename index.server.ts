/// <reference types="node" />
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { accountsFromConfig, addAccount, clearStatusCache, listAccounts, removeAccount, signInArgv, updateAccount, type ConfigApi, type Host } from "./server/accounts";
import { defaultHeadroomDeps } from "./server/headroom";
import { BatonRuntime } from "./server/runtime";
import { SignIns } from "./server/signin";
import { defaultUsageHost, paseoConfigPath, usageSources } from "./server/usage";
import { addRpc, listRpc, removeRpc, signInRpc, updateRpc, workspacesRpc } from "./shared/accounts";
import { DEFAULT_SETTINGS, batonSettings, chooserRpc, signInCancelRpc, signInCodeRpc, signInStartRpc, signInViewRpc, switchRpc } from "./shared/baton";

type Paseo = PluginHandlerContext["paseo"];

function host(paseo: Paseo): Host {
  return { config: paseo.config as unknown as ConfigApi, homedir: homedir(), platform: process.platform, env: process.env };
}

async function listWorkspaces(paseo: Paseo) {
  const workspaces: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const item of result.entries ?? []) {
      if (typeof item.id === "string") workspaces.push({ id: item.id, name: item.name || item.id });
    }
    const next = result.pageInfo?.nextCursor;
    if (!result.pageInfo?.hasMore || !next || next === cursor) break;
    cursor = next;
  }
  return { workspaces };
}

export default function contribute(server: PluginServerContext) {
  server.handle(listRpc, async ({ refresh }, { paseo }) => ({ accounts: await listAccounts(host(paseo), { refresh }), platform: process.platform }));
  server.handle(addRpc, async ({ kind, name }, { paseo }) => ({ account: await addAccount(host(paseo), kind, name) }));
  server.handle(updateRpc, async ({ id, label, enabled }, { paseo }) => updateAccount(host(paseo), id, { ...(label !== undefined ? { label } : {}), ...(enabled !== undefined ? { enabled } : {}) }));
  server.handle(removeRpc, async ({ id }, { paseo }) => removeAccount(host(paseo), id));
  server.handle(workspacesRpc, async (_input, { paseo }) => listWorkspaces(paseo));
  server.handle(signInRpc, async ({ id, workspaceId }, { paseo }) => {
    const { row, command, args } = await signInArgv(host(paseo), id);
    const terminal = await paseo.terminals.create({ workspaceId, name: `Sign in: ${row.label}`, command, args });
    return { terminalId: terminal.id };
  });
  // Usage for every extra account on Paseo's Usage page.
  for (const source of usageSources(defaultUsageHost())) server.registerUsageSource(source);

  // Switching: which account each chat runs on, moving it, and moving it automatically at a limit.
  const settings = server.registerSettings(batonSettings);
  const runtime = new BatonRuntime({
    host: (paseo) => host(paseo),
    settings: async () => {
      const state = await settings.read();
      return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
    },
    headroom: defaultHeadroomDeps(process.env, homedir()),
    now: () => Date.now(),
    log: (message) => console.warn(message),
  });
  const cleanups = [
    server.addHook("agent.create.before", (payload, { paseo }) => runtime.onCreate(payload, paseo)),
    server.addHook("agent.open.before", (payload, { paseo }) => runtime.onOpen(payload, paseo)),
    server.addHook("agent.turn.before", async (payload) => runtime.onTurnStart(payload)),
    // Not awaited by Paseo; moves wait for the chat to go idle on their own.
    server.addHook("agent.turn.after", async (payload, { paseo }) => void runtime.onTurnEnd(payload, paseo)),
  ];
  server.handle(chooserRpc, async (input, { paseo }) => runtime.chooser(paseo, input));
  server.handle(switchRpc, async ({ agentId, accountId }, { paseo }) => runtime.switchTo(paseo, agentId, accountId));

  // Signing in from inside Paseo, on any device.
  const signIns = new SignIns({
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    shimDir: join(dirname(paseoConfigPath(process.env, homedir())), "baton", "bin"),
    onSignedIn: () => clearStatusCache(),
  });
  server.handle(signInStartRpc, async ({ accountId, method, email }, { paseo }) => {
    const h = host(paseo);
    const { config } = await h.config.get();
    const row = accountsFromConfig(config.providers, h).find((item) => item.id === accountId);
    if (!row) throw new Error("That account no longer exists");
    return signIns.start({
      accountId,
      kind: row.kind,
      // The default login is signed in without a folder variable, exactly as the CLI does by default.
      home: row.defaultHome ? null : row.home,
      method: method === "code" ? "device-code" : "browser",
      providers: config.providers,
      label: row.label,
      identity: async () => (await listAccounts(h, { refresh: true })).find((item) => item.id === accountId)?.status.email,
      ...(email ? { email } : {}),
    });
  });
  server.handle(signInViewRpc, async ({ sessionId }) => signIns.view(sessionId));
  server.handle(signInCodeRpc, async ({ sessionId, code }) => {
    const result = await signIns.submitCode(sessionId, code);
    return { ok: result.ok, retry: result.retry, ...("error" in result ? { error: result.error } : {}) };
  });
  server.handle(signInCancelRpc, async ({ sessionId }) => {
    await signIns.cancel(sessionId);
    return { ok: true as const };
  });

  return () => {
    cleanups.forEach((cleanup) => cleanup());
    runtime.dispose();
    void signIns.dispose();
  };
}
