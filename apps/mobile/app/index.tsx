import { Redirect } from "expo-router";
import { useSession } from "../src/auth/client";

export default function Index() {
  const { data, isPending } = useSession();
  if (isPending) return null;
  return data?.user ? <Redirect href="/(tabs)" /> : <Redirect href="/(auth)/sign-in" />;
}
