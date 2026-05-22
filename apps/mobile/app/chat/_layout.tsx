import { Stack } from "expo-router";

// Chat detail (/chat/[tid]) sits OUTSIDE the tab bar so the message
// thread gets the full viewport — back button returns to the Chat tab.
export default function ChatLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
