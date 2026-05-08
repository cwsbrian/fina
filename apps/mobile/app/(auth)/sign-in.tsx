import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { signIn, signUp } from "../../src/auth/client";

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp") {
        const result = await signUp.email({ email, password, name: name || email.split("@")[0]! });
        if (result.error) throw new Error(result.error.message ?? "Sign up failed");
      } else {
        const result = await signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? "Sign in failed");
      }
      router.replace("/(tabs)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Fina</Text>
      <Text style={styles.subtitle}>Your AI financial advisor</Text>

      <Pressable onPress={() => setMode(mode === "signUp" ? "signIn" : "signUp")}>
        <Text style={styles.toggle}>
          {mode === "signUp" ? "Already have an account? Sign in" : "New here? Sign up"}
        </Text>
      </Pressable>

      {mode === "signUp" && (
        <TextInput style={styles.input} placeholder="Your name" value={name} onChangeText={setName} />
      )}
      <TextInput
        style={styles.input}
        placeholder="email@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password (8+ characters)"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        style={styles.button}
        disabled={busy || !email || password.length < 8}
        onPress={submit}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{mode === "signUp" ? "Create account" : "Sign in"}</Text>
        )}
      </Pressable>
      {err && <Text style={styles.error}>{err}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 36, fontWeight: "700", marginBottom: 4 },
  subtitle: { fontSize: 14, opacity: 0.6, marginBottom: 24 },
  toggle: { fontSize: 14, color: "#06f", marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    marginBottom: 12,
  },
  button: { backgroundColor: "#111", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  error: { color: "#c00", marginTop: 12 },
});
