import { useComposer, useRpc, type PluginComposerItemProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Select, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { AUTO_ACCOUNT, META_ACCOUNT, META_AGENT, chooserRpc, switchRpc, type AccountChoice, type SwitchRow } from "../shared/baton";

const AS_CONFIGURED = "__configured";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Work · 5h 42% · wk 18%", or why it can't be used. */
function describe(choice: AccountChoice): string {
  if (choice.state === "signed-out") return "Not signed in";
  if (choice.limitedUntil) return `At its limit until ${time(choice.limitedUntil)}`;
  return [choice.email, choice.detail, choice.usage].filter(Boolean).join(" · ") || "Usage not known yet";
}

function optionLabel(choice: AccountChoice): string {
  return choice.usage ? `${choice.label} · ${choice.usage}` : choice.label;
}

/**
 * The account a chat runs on, in the message box. In a new chat it picks the account to start on;
 * in a running Claude chat it moves the chat to another account and keeps the conversation.
 */
export function AccountControl({ host }: PluginComposerItemProps) {
  const composer = useComposer();
  const chooser = useRpc(chooserRpc);
  const switchTo = useRpc(switchRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const isAgent = composer.context === "agent";
  // Recorded on the agent by the server when its session opens.
  const agentId = isAgent ? text(composer.agent.metadata[META_AGENT]) : undefined;
  const provider = composer.agent.provider ?? undefined;
  const queryKey = ["baton-chooser", host.id, agentId ?? null, provider ?? null];
  const query = useQuery({
    queryKey,
    queryFn: () => chooser({ ...(agentId ? { agentId } : {}), ...(provider ? { provider } : {}) }),
    enabled: isAgent ? Boolean(agentId) : Boolean(provider),
    refetchInterval: 60_000,
  });
  const data = query.data;
  if (!data?.kind || data.choices.length < 2) return null;

  const options = data.choices.map((choice) => ({ value: choice.id, label: optionLabel(choice), description: describe(choice) }));

  if (isAgent && agentId) {
    const current = data.current ?? data.choices[0]!.id;
    return (
      <Select
        title={data.inPlace ? "Account: switch this chat to another account" : "Account: Codex chats stay on the account they started on"}
        icon="Users"
        value={current}
        disabled={!data.inPlace}
        options={options}
        onValueChange={async ({ value }) => {
          if (value === current) return;
          const result = await switchTo({ agentId, accountId: value });
          toast.show(result.deferred ? `Moves to ${result.label} when this turn ends` : `Now on ${result.label}`);
          await queryClient.invalidateQueries({ queryKey });
        }}
      />
    );
  }

  // A new chat: no choice means folder rules, then the model picker's account.
  const chosen = text(composer.agent.metadata[META_ACCOUNT]) ?? AS_CONFIGURED;
  return (
    <Select
      title="Account for this chat"
      icon="Users"
      value={chosen}
      options={[
        { value: AS_CONFIGURED, label: "Account: as configured", description: "Folder rules, else the model picker's account" },
        { value: AUTO_ACCOUNT, label: "Most headroom", description: "The signed-in account furthest from its limits" },
        ...options,
      ]}
      onValueChange={async ({ value }) => {
        await composer.setMetadata({ [META_ACCOUNT]: value === AS_CONFIGURED ? null : value });
      }}
    />
  );
}

/** Notes carry ISO times; show them in the reader's own time zone. */
function localTimes(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }));
}

const REASON: Record<SwitchRow["reason"], string> = {
  manual: "Switched account",
  limit: "Switched account at a usage limit",
  headroom: "Switched account before a usage limit",
  rule: "Account set by a folder rule",
  stuck: "Couldn't switch account",
};

/** The note Baton adds to a chat when it moves it, or can't. */
export function SwitchRowView({ item, theme }: PluginTimelineItemProps<SwitchRow>) {
  const row = item.data;
  const muted = theme.colors.foregroundMuted;
  const color = row.reason === "stuck" ? theme.colors.statusWarning : muted;
  const what = row.to ? `${REASON[row.reason]}: ${row.from ? `${row.from} → ` : ""}${row.to}` : REASON[row.reason];
  return (
    <View style={{ paddingVertical: 6, gap: 2 }} accessibilityRole="text">
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{what}</Text>
      {row.detail ? <Text style={{ color: muted, fontSize: 12 }}>{localTimes(row.detail)}</Text> : null}
    </View>
  );
}
