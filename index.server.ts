/// <reference types="node" />
import { homedir } from "node:os";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { addAccount, listAccounts, removeAccount, signInArgv, updateAccount, type ConfigApi, type Host } from "./server/accounts";
import { addRpc, listRpc, removeRpc, signInRpc, updateRpc, workspacesRpc } from "./shared/accounts";

type Paseo = PluginHandlerContext["paseo"];

function host(paseo: Paseo): Host {
  return { config: paseo.config as unknown as ConfigApi, homedir: homedir(), platform: process.platform };
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
  return () => {};
}
