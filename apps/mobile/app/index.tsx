import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSession } from "../src/auth/client";
import { ONBOARDING_SEEN_KEY } from "../src/onboarding/storage";
import { colors } from "../src/design/tokens";

export default function Index() {
  const { data, isPending } = useSession();
  const [seenLoaded, setSeenLoaded] = useState(false);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_SEEN_KEY).then((v) => {
      setSeen(v === "1");
      setSeenLoaded(true);
    });
  }, []);

  if (isPending || !seenLoaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }

  if (data?.user) return <Redirect href="/(tabs)" />;
  if (!seen) return <Redirect href="/(onboarding)" />;
  return <Redirect href="/(auth)/sign-in" />;
}
