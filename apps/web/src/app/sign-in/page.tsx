"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "../../auth/client";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp") {
        const r = await signUp.email({ email, password, name: name || email.split("@")[0]! });
        if (r.error) throw new Error(r.error.message ?? "Sign up failed");
      } else {
        const r = await signIn.email({ email, password });
        if (r.error) throw new Error(r.error.message ?? "Sign in failed");
      }
      router.replace("/home");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        display: "flex",
        justifyContent: "center",
        padding: 64,
        fontFamily: "system-ui",
      }}
    >
      <form onSubmit={submit} style={{ width: 360, display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ fontSize: 32, marginBottom: 8 }}>
          {mode === "signUp" ? "Create account" : "Sign in"}
        </h1>
        <button
          type="button"
          onClick={() => setMode(mode === "signUp" ? "signIn" : "signUp")}
          style={{
            background: "none",
            border: "none",
            color: "#06f",
            textAlign: "left",
            cursor: "pointer",
            padding: 0,
            marginBottom: 8,
          }}
        >
          {mode === "signUp" ? "Already have an account? Sign in" : "New here? Sign up"}
        </button>
        {mode === "signUp" && (
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}
          />
        )}
        <input
          type="email"
          placeholder="email@example.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}
        />
        <input
          type="password"
          placeholder="Password (8+ chars)"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}
        />
        <button
          type="submit"
          disabled={busy || !email || password.length < 8}
          style={{
            padding: 12,
            background: "#111",
            color: "#fff",
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
          }}
        >
          {busy ? "..." : mode === "signUp" ? "Create account" : "Sign in"}
        </button>
        {err && <div style={{ color: "#c00" }}>{err}</div>}
      </form>
    </main>
  );
}
