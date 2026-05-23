import { useState } from "react";
import { Pressable, Text, StyleSheet, Alert, ActivityIndicator } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { apiFetch } from "../api/client";
import { getActiveWorkspaceId } from "../workspace/active";
import { colors, space, type as type$ } from "../design/tokens";

type LinkTokenResp = {
  linkToken: string;
  expiration: string;
  hostedLinkUrl?: string;
};

type Props = {
  /** Fires after a successful exchange so the parent can refresh the
   *  account list / dismiss the empty state. */
  onConnected?: () => void;
  /** Pass true to render as a smaller secondary button (e.g. inside More
   *  tab's "Connected banks" section). Default false → primary CTA. */
  compact?: boolean;
  label?: string;
};

WebBrowser.maybeCompleteAuthSession();

/** Mobile Plaid Link via Hosted Link + system browser. Expo Go can't
 *  ship `react-native-plaid-link-sdk` (native module), so the flow is:
 *  - POST /plaid/link-token with hosted=true + completion_redirect_uri
 *  - Open the returned hostedLinkUrl in a WebBrowser auth session
 *  - Plaid redirects back to fina://plaid/oauth?public_token=...
 *  - POST /plaid/exchange to finalize, then notify the parent. */
export function ConnectBankButton({ onConnected, compact, label }: Props) {
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");

      const redirectUri = Linking.createURL("plaid/oauth");
      const tokenResp = await apiFetch<LinkTokenResp>(
        `/workspaces/${wsId}/plaid/link-token`,
        {
          method: "POST",
          body: JSON.stringify({
            hosted: true,
            completionRedirectUri: redirectUri,
          }),
        },
      );

      if (!tokenResp.hostedLinkUrl) {
        Alert.alert(
          "Plaid not ready",
          "Server didn't return a hosted Link URL.",
        );
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(
        tokenResp.hostedLinkUrl,
        redirectUri,
      );

      if (result.type !== "success" || !result.url) {
        // User closed / cancelled — don't error, just stop.
        return;
      }

      const parsed = Linking.parse(result.url);
      const publicToken = parsed.queryParams?.public_token as
        | string
        | undefined;
      if (!publicToken) {
        Alert.alert(
          "Couldn't link",
          "No public token returned from Plaid. Try again.",
        );
        return;
      }

      // Institution metadata isn't part of the hosted-link redirect — pass
      // placeholders. The Plaid sync that follows the exchange pulls real
      // account/institution data from /accounts/get.
      await apiFetch(`/workspaces/${wsId}/plaid/exchange`, {
        method: "POST",
        body: JSON.stringify({
          publicToken,
          institutionId: "unknown",
          institutionName: "Bank",
        }),
      });

      onConnected?.();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      Alert.alert(
        "Couldn't connect bank",
        code === "upgrade_required"
          ? "Pro tier is required to connect a bank."
          : code === "plaid_item_limit"
            ? "Reached your tier's bank-account limit."
            : `Try again (${code}).`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={connect}
      disabled={busy}
      style={({ pressed }) => [
        compact ? styles.compact : styles.primary,
        pressed && { opacity: 0.85 },
        busy && { opacity: 0.7 },
      ]}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={compact ? colors.primary : colors.onPrimary}
        />
      ) : (
        <Text style={compact ? styles.compactText : styles.primaryText}>
          {label ?? "Connect a bank"}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  primaryText: { ...type$.button, color: colors.onPrimary },
  compact: {
    paddingHorizontal: space.base,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  compactText: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
});
