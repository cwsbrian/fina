"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, signUp } from "../../auth/client";
import { apiFetch } from "../../lib/api";
import { env } from "../../env";

type InvitePreview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedEmail: string;
};

export function SignInForm() {
  const router = useRouter();
  const search = useSearchParams();
  const fromParam = search?.get("from") ?? "";
  // Only honor internal paths (defense against open-redirect via crafted query).
  const safeFrom = fromParam.startsWith("/") && !fromParam.startsWith("//") ? fromParam : null;
  // When the user arrives via an invite link the form fetches the preview to
  // discover the invited email — we never trust an email passed via URL/query.
  // The fetched email is then pre-filled + locked in the input. On submit:
  //   - Sign-up goes to the invite-aware endpoint which RE-VALIDATES email
  //     server-side (form-level readonly is just UX; the real guarantee is
  //     server-side rejection if the submitted email doesn't match).
  //   - Sign-in is plain Better Auth; the post-redirect invite page will block
  //     accept if the wrong account was used.
  const inviteToken = search?.get("inviteToken") ?? null;
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    apiFetch<InvitePreview>(`/invites/by-token/${encodeURIComponent(inviteToken)}`)
      .then((p) => {
        setLockedEmail(p.invitedEmail);
        setEmail(p.invitedEmail);
      })
      .catch((e) => setPreviewErr((e as { code?: string }).code ?? "load_error"));
  }, [inviteToken]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp" && inviteToken) {
        // Invite-aware sign-up: server re-validates email vs invite. If the
        // user removed `readonly` and typed a different email, this is where
        // they get rejected with a clear `wrong_email` error.
        const res = await fetch(
          `${env.NEXT_PUBLIC_API_URL}/invites/by-token/${encodeURIComponent(inviteToken)}/sign-up`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, name: name || email.split("@")[0] }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            invitedEmail?: string;
            message?: string;
          };
          if (body.error === "wrong_email") {
            throw new Error(
              `This invite is for ${body.invitedEmail ?? "a different email"}. ` +
                `Sign up with that email to accept it.`,
            );
          }
          throw new Error(body.message ?? body.error ?? `Sign up failed (${res.status})`);
        }
        // Hard navigation: our wrapper endpoint set the session cookie, but
        // Better Auth's React client never observed it (we bypassed signUp.email
        // to do the email validation). A full reload makes useSession() refetch
        // /api/auth/get-session against the freshly-set cookie. Soft router
        // navigation would leave the client's in-memory session as null and
        // the invite page would render the signed-out branch again.
        window.location.href = safeFrom ?? "/home";
        return;
      } else if (mode === "signUp") {
        const r = await signUp.email({ email, password, name: name || email.split("@")[0]! });
        if (r.error) throw new Error(r.error.message ?? "Sign up failed");
      } else {
        const r = await signIn.email({ email, password });
        if (r.error) throw new Error(r.error.message ?? "Sign in failed");
      }
      router.replace(safeFrom ?? "/home");
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
        {previewErr && (
          <div style={{ color: "#c00", fontSize: 13 }}>
            Could not load invite preview ({previewErr}).
          </div>
        )}
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
          readOnly={lockedEmail !== null}
          style={{
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            ...(lockedEmail !== null ? { background: "#f5f5f5", color: "#666" } : {}),
          }}
        />
        {lockedEmail !== null && (
          <p style={{ fontSize: 12, opacity: 0.6, margin: "-4px 0 0" }}>
            Email locked to the invited address. To use a different email, open{" "}
            <strong>/sign-in</strong> directly (without the invite link).
          </p>
        )}
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
