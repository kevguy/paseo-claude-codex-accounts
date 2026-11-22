import { openExternalUrl, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, copyText, useToast, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Account } from "../shared/accounts";
import { signInCancelRpc, signInCodeRpc, signInStartRpc, signInViewRpc, type SignInView } from "../shared/switching";

type Theme = PluginSurfaceProps["theme"];

/**
 * Signing an account in without a terminal. Works from a phone: Claude's page shows a code to paste
 * here, and Codex can show a device code to enter on any browser.
 */
export function SignInHere({ account, theme, onDone }: { account: Account; theme: Theme; onDone(): void }) {
  const start = useRpc(signInStartRpc), view = useRpc(signInViewRpc), submit = useRpc(signInCodeRpc), cancel = useRpc(signInCancelRpc);
  const toast = useToast();
  const [session, setSession] = useState<{ id: string; view: SignInView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const input = useRef<SettingsInputHandle>(null);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };

  // Follow the session until it finishes; the sign-in happens in another tab or device.
  useEffect(() => {
    if (!session || session.view.state !== "waiting") return;
    const timer = setInterval(() => {
      void view({ sessionId: session.id }).then((next) => {
        if (next.state === "waiting") return setSession((current) => (current ? { ...current, view: next } : current));
        setSession(null);
        if (next.state === "done") {
          if (next.warning) toast.error(next.warning);
          else toast.show(next.email ? `${account.label} signed in as ${next.email}` : `${account.label} signed in`);
          onDone();
        } else toast.error(next.error);
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, session?.view.state]);

  // Leaving the screen ends a sign-in that hasn't finished.
  useEffect(() => () => {
    if (session) void cancel({ sessionId: session.id }).catch(() => undefined);
  }, [session?.id]);

  const begin = async (method: "browser" | "code") => {
    setBusy(true);
    try {
      const started = await start({ accountId: account.id, method });
      setSession({ id: started.sessionId, view: started.view });
      if (started.view.state === "waiting" && (account.kind === "claude" || method === "browser")) await openExternalUrl(started.view.url).catch(() => undefined);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!session || session.view.state !== "waiting") {
    return account.kind === "claude" ? (
      <SettingsAction label="Sign in here" hint="Opens Claude's sign-in page on this device. No terminal needed." actionLabel={busy ? "Starting…" : "Sign in"} disabled={busy} onPress={() => void begin("code")} />
    ) : (
      <>
        <SettingsAction label="Sign in with a code" hint="Works on any device: enter a short code at chatgpt.com." actionLabel={busy ? "Starting…" : "Get code"} disabled={busy} onPress={() => void begin("code")} />
        <SettingsAction label="Sign in on the host computer" hint="Opens ChatGPT's sign-in page. Finishes only in a browser on the computer running Paseo." actionLabel="Sign in" disabled={busy} onPress={() => void begin("browser")} />
      </>
    );
  }

  const waiting = session.view;
  const stop = () => {
    void cancel({ sessionId: session.id }).catch(() => undefined);
    setSession(null);
  };
  return (
    <View>
      {waiting.code ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Go to {waiting.url} and enter this code:</Text>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700", letterSpacing: 2 }}>{waiting.code}</Text>
          <Text style={muted}>This page updates by itself when you're done.</Text>
        </View>
      ) : null}
      <SettingsAction label="Sign-in page" hint={waiting.needsCode ? "Sign in there, then copy the code it shows" : "Sign in there; this updates by itself"} actionLabel="Open" onPress={() => void openExternalUrl(waiting.url)} />
      <SettingsAction label="Sign-in link" hint="To open it on another device" actionLabel="Copy" onPress={() => void copyText(waiting.url).then(() => toast.show("Copied"))} />
      {waiting.code ? <SettingsAction label="Code" actionLabel="Copy" onPress={() => void copyText(waiting.code!).then(() => toast.show("Copied"))} /> : null}
      {waiting.needsCode ? (
        <>
          <SettingsInput ref={input} label="Code from the page" hint="Paste the whole code, including the part after #" placeholder="Paste code" onChangeText={setCode} disabled={busy} secureTextEntry />
          <SettingsAction
            label="Finish signing in"
            actionLabel={busy ? "Checking…" : "Submit"}
            disabled={busy || !code.trim()}
            onPress={async () => {
              setBusy(true);
              try {
                const result = await submit({ sessionId: session.id, code });
                input.current?.replaceText("");
                setCode("");
                if (!result.ok) toast.error(result.error ?? "That code didn't work");
              } finally {
                setBusy(false);
              }
            }}
          />
        </>
      ) : null}
      {waiting.localUrl ? (
        <SettingsAction label="On the computer running Paseo?" hint="Sign in there without a code" actionLabel="Open" onPress={() => void openExternalUrl(waiting.localUrl!)} />
      ) : null}
      <SettingsAction label="Stop signing in" actionLabel="Cancel" onPress={stop} />
    </View>
  );
}
