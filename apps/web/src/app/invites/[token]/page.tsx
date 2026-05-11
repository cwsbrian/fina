"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, signOut } from "../../../auth/client";
import { apiFetch } from "../../../lib/api";
import { AcceptButton } from "./_accept-button";

type Preview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  workspaceName: string;
  inviterEmail: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  // null when the GET was anonymous; boolean when authenticated.
  emailMatch: boolean | null;
};

export default function InvitePage({ params }: { params: { token: string } }) {
  const { data: session, isPending: sessionLoading } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    // Always fetch the preview — the API allows anonymous reads so that the
    // signed-out branch can show the invite details + a sign-up link with
    // the invited email pre-filled.
    setLoadErr(null);
    apiFetch<Preview>(`/invites/by-token/${encodeURIComponent(params.token)}`)
      .then(setPreview)
      .catch((e) => setLoadErr((e as { code?: string }).code ?? "load_error"));
  }, [params.token]);

  // The sign-in target carries `from` (so the user lands back here after auth)
  // and `inviteToken` (so the form fetches the invite preview itself, pre-fills
  // the email from the SERVER's invitedEmail, locks the input, and POSTs sign-up
  // to the invite-aware endpoint that re-validates email server-side). We
  // intentionally do NOT pass the email in the URL — it would be both leaked
  // in browser history and trivially user-modifiable.
  const inviteRel = `/invites/${params.token}`;
  const signInHref = `/sign-in?from=${encodeURIComponent(inviteRel)}&inviteToken=${encodeURIComponent(params.token)}`;

  return (
    <main style={{ maxWidth: 480, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 16 }}>You&apos;ve been invited to Fina</h1>

      {(sessionLoading || (!loadErr && !preview)) && <p>Loading…</p>}

      {loadErr === "not_found" && (
        <p style={{ color: "#c00" }}>This invite link is invalid or has been deleted.</p>
      )}

      {loadErr && loadErr !== "not_found" && (
        <p style={{ color: "#c00" }}>Could not load invite ({loadErr}).</p>
      )}

      {!sessionLoading && preview && (
        <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>From</div>
          <div style={{ fontSize: 16, marginBottom: 12 }}>{preview.inviterEmail}</div>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>Workspace</div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
            {preview.workspaceName}
          </div>
          <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>You&apos;d join as</div>
          <div style={{ fontSize: 16, marginBottom: 16 }}>{preview.invitedRole}</div>

          {preview.status !== "pending" && (
            <p style={{ color: "#c00" }}>This invite is {preview.status}.</p>
          )}

          {preview.status === "pending" && !session?.user && (
            <div>
              <p style={{ marginBottom: 12 }}>
                Invited as <strong>{preview.invitedEmail}</strong>. Sign in or create an account
                with that email to accept.
              </p>
              <Link
                href={signInHref}
                style={{
                  display: "inline-block",
                  padding: "12px 24px",
                  background: "#111",
                  color: "#fff",
                  borderRadius: 8,
                  textDecoration: "none",
                }}
              >
                Sign in / Sign up as {preview.invitedEmail}
              </Link>
            </div>
          )}

          {preview.status === "pending" && session?.user && preview.emailMatch === false && (
            <div>
              <p style={{ marginBottom: 12 }}>
                This invite is for <strong>{preview.invitedEmail}</strong>. You&apos;re signed in as{" "}
                <strong>{session.user.email}</strong>.
              </p>
              <button
                onClick={() => signOut()}
                style={{
                  padding: "12px 24px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                Sign out and try again
              </button>
            </div>
          )}

          {preview.status === "pending" && session?.user && preview.emailMatch === true && (
            <AcceptButton token={params.token} />
          )}
        </div>
      )}
    </main>
  );
}
