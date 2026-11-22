import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, copyText, useToast, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KINDS, KIND_INFO, addRpc, listRpc, removeRpc, signInRpc, slugify, updateRpc, workspacesRpc, type Account, type AccountKind, type AccountStatus } from "../shared/accounts";

type Theme = PluginSurfaceProps["theme"];

const STATE_LABEL: Record<AccountStatus["state"], string> = {
  "signed-in": "Signed in",
  "signed-out": "Not signed in",
  unknown: "Status unknown",
};

function stateColor(theme: Theme, state: AccountStatus["state"]) {
  if (state === "signed-in") return theme.colors.statusSuccess;
  if (state === "signed-out") return theme.colors.foregroundMuted;
  return theme.colors.statusWarning;
}

export function statusLine(status: AccountStatus): string {
  return [STATE_LABEL[status.state], status.email, status.organization, status.plan].filter(Boolean).join(" · ");
}

function AccountCard({ account, platform, workspaceId, theme, onChanged, onOpenWorkspace }: {
  account: Account;
  platform: string;
  workspaceId: string | null;
  theme: Theme;
  onChanged(): void;
  onOpenWorkspace?(workspaceId: string): void;
}) {
  const update = useRpc(updateRpc), remove = useRpc(removeRpc), signIn = useRpc(signInRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Signed-in accounts stay compact so a long list is easy to scan; the rest open their options.
  const [open, setOpen] = useState(account.status.state !== "signed-in");
  // The second press has to follow soon after the first; otherwise the button resets.
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 6000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const run = async (work: () => Promise<unknown>, done?: string, refresh = true) => {
    setBusy(true);
    try {
      await work();
      if (done) toast.show(done);
      if (refresh) onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const command = account.signIn.find((c) => c.shell === (platform === "win32" ? "powershell" : "posix"))?.text ?? account.signIn[0]?.text ?? "";
  return (
    <SettingsCard testID={`account-${account.id}`}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stateColor(theme, account.status.state) }} />
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{account.label}</Text>
          {account.isDefault ? <Text style={muted}>default</Text> : null}
          <View style={{ flex: 1 }} />
          {/* Only this toggle is a button, so screen readers still read the status text, and selecting the path doesn't toggle. */}
          <Pressable
            onPress={() => setOpen((value) => !value)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${open ? "Hide" : "Show"} options for ${account.label}`}
            hitSlop={8}
          >
            <Text style={muted}>{open ? "Less ▴" : "More ▾"}</Text>
          </Pressable>
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{statusLine(account.status)}</Text>
        <Text style={muted} selectable>{account.displayHome}</Text>
        {account.status.detail ? <Text style={{ ...muted, color: theme.colors.statusWarning }}>{account.status.detail}</Text> : null}
      </View>
      <SettingsSwitch
        label="Show in model picker"
        hint={account.enabled ? undefined : "Hidden. Its folder and login are kept."}
        value={account.enabled}
        disabled={busy}
        onValueChange={(enabled) => run(() => update({ id: account.id, enabled }))}
      />
      {open ? (
        <>
        <SettingsAction
          label={account.status.state === "signed-in" ? "Sign in again" : "Sign in"}
          hint={workspaceId ? "Opens a terminal in the selected workspace" : "Choose a workspace below, or copy the command"}
          actionLabel="Open terminal"
          disabled={busy || !workspaceId}
          onPress={() => workspaceId && run(async () => {
            await signIn({ id: account.id, workspaceId });
            onOpenWorkspace?.(workspaceId);
          }, "Sign-in terminal opened. Press Refresh below when you're done.", false)}
        />
        <SettingsAction label="Sign-in command" hint={command} actionLabel="Copy" onPress={() => void copyText(command).then(() => toast.show("Copied"))} />
        {account.managed ? (
          <SettingsAction
            label={confirmRemove ? "Remove from Paseo? The folder and its login stay." : "Remove account"}
            actionLabel={confirmRemove ? "Remove" : "Remove…"}
            disabled={busy}
            onPress={() => {
              if (!confirmRemove) return setConfirmRemove(true);
              void run(() => remove({ id: account.id }), `Removed. Folder kept at ${account.home}`);
            }}
          />
        ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

function AddAccount({ theme, platform, onAdded }: { theme: Theme; platform: string; onAdded(): void }) {
  const add = useRpc(addRpc);
  const toast = useToast();
  const [kind, setKind] = useState<AccountKind>("claude");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<SettingsInputHandle>(null);
  const slug = slugify(name);
  const hint = name.trim()
    ? slug ? `Creates ${KIND_INFO[kind].label} (${name.trim()}) using the folder ~${platform === "win32" ? "\\" : "/"}${KIND_INFO[kind].folderPrefix}${slug}` : "Use at least one letter or number"
    : "For example: Work, Personal, Client A";
  return (
    <SettingsSection title="Add an account">
      <SettingsCard>
        <SettingsSelect label="Provider" value={kind} options={KINDS.map((value) => ({ value, label: KIND_INFO[value].label }))} onValueChange={(value) => setKind(value as AccountKind)} />
        <SettingsInput ref={input} label="Name" hint={hint} placeholder="Work" onChangeText={setName} disabled={busy} />
        <SettingsAction
          label="Add, then sign in"
          actionLabel={busy ? "Adding…" : "Add account"}
          disabled={busy || !slug}
          onPress={async () => {
            setBusy(true);
            try {
              const { account } = await add({ kind, name });
              toast.show(`${account.label} added. Sign in to use it.`);
              input.current?.replaceText("");
              setName("");
              onAdded();
            } catch (error) {
              toast.error((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 4 }}>
        Each account gets its own folder, so its login, settings and history stay separate.
      </Text>
    </SettingsSection>
  );
}

export function AccountsScreen({ theme, host, navigation }: PluginSurfaceProps) {
  const list = useRpc(listRpc), listWorkspaces = useRpc(workspacesRpc);
  const queryClient = useQueryClient();
  const accountsKey = ["paseo-accounts", host.id];
  const accounts = useQuery({ queryKey: accountsKey, queryFn: () => list({ refresh: false }) });
  const workspaces = useQuery({ queryKey: ["paseo-accounts-workspaces", host.id], queryFn: () => listWorkspaces({}) });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const chosenWorkspace = workspaceId ?? workspaces.data?.workspaces[0]?.id ?? null;
  const refresh = async () => queryClient.setQueryData(accountsKey, await list({ refresh: true }));
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };

  if (accounts.isLoading) return <Text style={muted}>Loading accounts…</Text>;
  if (accounts.error || !accounts.data) {
    return (
      <SettingsSection title="Accounts">
        <Text style={muted}>{(accounts.error as Error | null)?.message ?? "Couldn't load accounts"}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void accounts.refetch()} />
      </SettingsSection>
    );
  }
  const { platform } = accounts.data;
  return (
    <View style={{ gap: 24 }}>
      {KINDS.map((kind) => {
        const rows = accounts.data.accounts.filter((account) => account.kind === kind);
        const signedIn = rows.filter((account) => account.status.state === "signed-in").length;
        return (
          <SettingsSection key={kind} title={`${KIND_INFO[kind].label} accounts · ${signedIn} of ${rows.length} signed in`}>
            {rows.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                platform={platform}
                workspaceId={chosenWorkspace}
                theme={theme}
                onChanged={() => void refresh()}
                {...(navigation ? { onOpenWorkspace: (id: string) => navigation.openWorkspace({ workspaceId: id, serverId: host.id }) } : {})}
              />
            ))}
          </SettingsSection>
        );
      })}
      <AddAccount theme={theme} platform={platform} onAdded={() => void refresh()} />
      <SettingsSection title="Sign-in terminal">
        <SettingsCard>
          {workspaces.data?.workspaces.length ? (
            <SettingsSelect
              label="Open sign-in terminals in"
              value={chosenWorkspace ?? ""}
              options={workspaces.data.workspaces.map((w) => ({ value: w.id, label: w.name }))}
              onValueChange={setWorkspaceId}
            />
          ) : (
            <Text style={{ ...muted, padding: 16 }}>No workspace is open on this host. Copy an account's sign-in command and run it in a terminal instead.</Text>
          )}
          <SettingsAction label="Check sign-in status again" actionLabel="Refresh" onPress={() => void refresh()} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
