import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsScreen } from "./client/accounts";

const SETTINGS_ID = "accounts";

/** Accounts lives in Settings; the Command Center jumps straight to it. */
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({ id: SETTINGS_ID, title: "Accounts", icon: "Users", Component: AccountsScreen }),
    client.addCommandCenterItem({
      id: "accounts",
      title: "Manage Claude and Codex accounts",
      icon: "Users",
      keywords: ["account", "login", "sign in", "claude", "codex", "profile", "settings"],
      context: "global",
      onSelect: ({ openSettings }) => openSettings(SETTINGS_ID),
    }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
