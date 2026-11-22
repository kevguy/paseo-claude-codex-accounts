import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsScreen } from "./client/accounts";

const SCREEN_ID = "accounts-home";

function AccountsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Users" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({ id: "accounts", title: "Accounts", icon: "Users", Component: AccountsScreen }),
    client.addScreen({ id: SCREEN_ID, title: "Accounts", Component: AccountsScreen }),
    client.addSidebarHeaderItem({ id: "accounts", title: "Accounts", Component: AccountsItem }),
    client.addCommandCenterItem({ id: "accounts", title: "Manage Claude and Codex accounts", icon: "Users", keywords: ["account", "login", "sign in", "claude", "codex", "profile"], context: "global", onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN_ID }) }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
