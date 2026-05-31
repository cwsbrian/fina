import { useState } from "react";
import { Pressable, Text, StyleSheet, Alert, ActivityIndicator } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { isApiError, type ApiErrorCode } from "@fina/shared";
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
 *  - Plaid redirects back to the completion URI. Hosted Link does NOT put
 *    the public_token in that redirect — it only signals the session ended.
 *  - POST /plaid/hosted-token to fetch the public_token + real institution
 *    server-side (via /link/token/get), then POST /plaid/exchange to finalize. */
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

      // The redirect only signals completion — Hosted Link doesn't include the
      // public_token. Retrieve it (+ the real institution) from the server via
      // /link/token/get, then exchange.
      type HostedTokenResp = {
        publicToken: string;
        institutionId: string;
        institutionName: string;
      };
      const resolved = await apiFetch<HostedTokenResp>(
        `/workspaces/${wsId}/plaid/hosted-token`,
        {
          method: "POST",
          body: JSON.stringify({ linkToken: tokenResp.linkToken }),
        },
      );

      await apiFetch(`/workspaces/${wsId}/plaid/exchange`, {
        method: "POST",
        body: JSON.stringify(resolved),
      });

      onConnected?.();
    } catch (e) {
      if (!isApiError(e)) {
        Alert.alert("Couldn't connect bank", "Something went wrong. Try again.");
        return;
      }
      // `satisfies` validates every key against the shared ApiErrorCode union
      // (a typo is a TS error — the old `plaid_item_limit` check never matched
      // `plaid_item_limit_reached`) while keeping the object plainly indexable
      // (ApiErrorCode's `http_${number}` member blocks a direct Record index).
      const messages = {
        plaid_link_incomplete: "Bank linking wasn't completed. Try again.",
        upgrade_required: "Pro tier is required to connect a bank.",
        plaid_item_limit_reached: "Reached your tier's bank-account limit.",
        currency_mismatch: "That account's currency doesn't match this workspace.",
        already_connected: "That bank is already connected.",
        plaid_link_expired: "The link expired — try connecting again.",
      } satisfies Partial<Record<ApiErrorCode, string>>;
      const msg =
        (messages as Record<string, string | undefined>)[e.code] ??
        `Try again (${e.code}).`;
      Alert.alert("Couldn't connect bank", msg);
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
