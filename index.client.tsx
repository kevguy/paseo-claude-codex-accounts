import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { AccountsScreen } from "./client/accounts";
import { AccountControl, SwitchRowView } from "./client/composer";
import { SWITCH_ROW_KIND, switchRowSchema } from "./shared/baton";

const SETTINGS_ID = "accounts";
const PANEL_ID = "accounts";

/** The same screen as a workspace tab, opened from the workspace's + menu. */
function AccountsPanel({ theme, host, navigation, workspaceId }: PluginWorkspacePanelProps) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <AccountsScreen theme={theme} host={host} {...(navigation ? { navigation } : {})} workspaceId={workspaceId} />
    </ScrollView>
  );
}

/** Accounts lives in Settings and in each workspace's + menu; the Command Center opens it too. */
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({ id: SETTINGS_ID, title: "Accounts", icon: "Users", Component: AccountsScreen }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Accounts", icon: "Users", locations: ["workspace"], Component: AccountsPanel }),
    client.addCommandCenterItem({
      id: "accounts",
      title: "Baton: Claude and Codex accounts",
      icon: "Users",
      keywords: ["account", "login", "sign in", "claude", "codex", "profile", "settings"],
      context: "global",
      onSelect: ({ openSettings }) => openSettings(SETTINGS_ID),
    }),
    // The account a chat runs on, in every message box; it also moves a running Claude chat.
    client.addComposerItem({ id: "account", Component: AccountControl }),
    client.addTimelineRenderer({ kind: SWITCH_ROW_KIND, version: 1, schema: switchRowSchema, Component: SwitchRowView }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
