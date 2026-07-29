import { Redirect } from "expo-router";

/**
 * Legacy route kept so old links do not break. Thread selection is no longer
 * part of the product: the Chat tab resolves the active workspace's one
 * canonical conversation.
 */
export default function LegacyChatsRedirect() {
  return <Redirect href="/(tabs)/chat" />;
}
