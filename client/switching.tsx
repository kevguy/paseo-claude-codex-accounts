import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, useToast, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import type { Account } from "../shared/accounts";
import { batonSettings, type BatonSettings } from "../shared/baton";

type Theme = PluginSurfaceProps["theme"];

const EARLY = [
  { value: "100", label: "Only at the limit" },
  { value: "95", label: "At 95% of a limit" },
  { value: "90", label: "At 90% of a limit" },
  { value: "80", label: "At 80% of a limit" },
];

/** How Baton picks and moves accounts: automatic switching, new chats, and folder rules. */
export function SwitchingSettings({ theme, accounts, platform }: { theme: Theme; accounts: readonly Account[]; platform: string }) {
  const settings = useSettings(batonSettings);
  const toast = useToast();
  const [pattern, setPattern] = useState("");
  const [ruleAccount, setRuleAccount] = useState<string>("");
  const input = useRef<SettingsInputHandle>(null);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 4 };

  if (settings.status === "loading") return <Text style={muted}>Loading switching settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Switching">
        <Text style={muted}>{settings.error}</Text>
        <SettingsAction label="Use the defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
      </SettingsSection>
    );
  }
  const values = settings.values;
  const save = async (change: Partial<BatonSettings>) => {
    const ok = await settings.save({ ...values, ...change }, settings.revision);
    if (!ok) toast.error(settings.saveError ?? "Couldn't save. Reload and try again.");
  };
  const usable = accounts.filter((account) => account.status.state !== "signed-out" || account.isDefault);
  const label = (id: string) => accounts.find((account) => account.id === id)?.label ?? `${id} (removed)`;
  const chosenRuleAccount = ruleAccount || usable[0]?.id || "";
  const example = platform === "win32" ? "~\\work or C:\\Clients\\**" : "~/work or ~/clients/acme/**";

  return (
    <>
      <SettingsSection title="Switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch Claude chats automatically"
            hint="When an account hits a usage limit, the chat moves to the signed-in account with the most room, and keeps its conversation."
            value={values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => void save({ autoSwitch })}
          />
          <SettingsSelect
            label="Switch early"
            hint="Move between turns before the limit interrupts work"
            value={String(values.switchBeforePercent)}
            options={EARLY}
            disabled={settings.saving || !values.autoSwitch}
            onValueChange={(value) => void save({ switchBeforePercent: Number(value) })}
          />
          <SettingsSwitch
            label="Carry on after a limit"
            hint="Tell the chat to continue where it stopped, unless you've written to it since."
            value={values.continueAfterSwitch}
            disabled={settings.saving || !values.autoSwitch}
            onValueChange={(continueAfterSwitch) => void save({ continueAfterSwitch })}
          />
          <SettingsSwitch
            label="Wait out a limit when every account is at one"
            hint="Carry on by itself when the first limit resets, unless you've written to the chat since. Forgotten if Paseo restarts."
            value={values.waitForReset}
            disabled={settings.saving}
            onValueChange={(waitForReset) => void save({ waitForReset })}
          />
          <SettingsSelect
            label="New chats start on"
            value={values.newChats}
            options={[
              { value: "picker", label: "The model picker's account" },
              { value: "most-headroom", label: "The account with the most room" },
            ]}
            disabled={settings.saving}
            onValueChange={(newChats) => void save({ newChats: newChats as BatonSettings["newChats"] })}
          />
        </SettingsCard>
        <Text style={muted}>
          Codex chats stay on the account they started on, because Codex encrypts each conversation for its account. Pick a Codex chat's account when you start it.
        </Text>
      </SettingsSection>

      <SettingsSection title="Scripts and orchestrators">
        <SettingsCard>
          <SettingsSwitch
            label="Give agents account tools"
            hint="Adds baton_accounts and baton_switch to new and reopened chats, so an agent can see every account's room and move chats."
            value={values.agentTools}
            disabled={settings.saving}
            onValueChange={(agentTools) => void save({ agentTools })}
          />
        </SettingsCard>
        <Text selectable style={muted}>
          Start or import a Claude chat on an account with a label: paseo run --label baton.account={accounts.find((account) => !account.isDefault && account.kind === "claude")?.id ?? "claude-work"} "…"
        </Text>
      </SettingsSection>

      <SettingsSection title="Folder rules">
        <SettingsCard>
          {values.rules.map((rule, index) => (
            <SettingsAction
              key={`${index}-${rule.pattern}`}
              label={rule.pattern}
              hint={`New chats here use ${label(rule.accountId)}`}
              actionLabel="Remove"
              disabled={settings.saving}
              onPress={() => void save({ rules: values.rules.filter((_, at) => at !== index) })}
            />
          ))}
          <SettingsInput ref={input} label="Folder" hint={`For example ${example}. Covers everything inside it; * and ** match names.`} placeholder={platform === "win32" ? "~\\work" : "~/work"} onChangeText={setPattern} disabled={settings.saving} />
          {usable.length ? (
            <SettingsSelect label="Use account" value={chosenRuleAccount} options={usable.map((account) => ({ value: account.id, label: account.label }))} onValueChange={setRuleAccount} disabled={settings.saving} />
          ) : null}
          <SettingsAction
            label="Add rule"
            actionLabel="Add"
            disabled={settings.saving || !pattern.trim() || !chosenRuleAccount}
            onPress={async () => {
              const value = pattern.trim();
              if (!/^(~|[\\/]|[A-Za-z]:[\\/])/.test(value)) return toast.error("Start the folder with ~ or a full path");
              await save({ rules: [...values.rules, { pattern: value, accountId: chosenRuleAccount }] });
              input.current?.replaceText("");
              setPattern("");
            }}
          />
        </SettingsCard>
        <Text style={muted}>The most specific rule wins. Rules apply to new chats that use the plain Claude or Codex provider; picking an account in the model picker or the message box overrides them.</Text>
      </SettingsSection>
    </>
  );
}
