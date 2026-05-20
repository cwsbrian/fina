"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, signOut } from "../../../auth/client";
import { apiFetch } from "../../../lib/api";
import { AuthTopBar } from "../../../components/AuthTopBar";
import { WebIcon } from "../../../components/WebIcon";
import { AcceptButton } from "./_accept-button";
import styles from "../../../components/auth.module.css";

type Preview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  workspaceName: string;
  inviterEmail: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  emailMatch: boolean | null;
};

export default function InvitePage({ params }: { params: { token: string } }) {
  const { data: session, isPending: sessionLoading } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    setLoadErr(null);
    apiFetch<Preview>(`/invites/by-token/${encodeURIComponent(params.token)}`)
      .then(setPreview)
      .catch((e) => setLoadErr((e as { code?: string }).code ?? "load_error"));
  }, [params.token]);

  const inviteRel = `/invites/${params.token}`;
  const signInHref = `/sign-in?from=${encodeURIComponent(inviteRel)}&inviteToken=${encodeURIComponent(params.token)}`;

  return (
    <div className={styles.page}>
      <AuthTopBar homePath="/" />
      <div className={styles.body}>
        <div className={`${styles.card} ${styles.cardWide}`}>
          {(sessionLoading || (!loadErr && !preview)) && (
            <p
              className={styles.sub}
              style={{ textAlign: "center", marginBottom: 0 }}
            >
              Loading…
            </p>
          )}

          {loadErr === "not_found" && (
            <div className={styles.inviteCard}>
              <div
                className={`${styles.inviteIcon} ${styles.inviteIconDanger}`}
              >
                <WebIcon name="alert" size={28} />
              </div>
              <h1 className={styles.title} style={{ marginBottom: 10 }}>
                Invite not found
              </h1>
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                This invite link is invalid or has been deleted. Ask whoever
                invited you to send a new one.
              </p>
            </div>
          )}

          {loadErr && loadErr !== "not_found" && (
            <div className={styles.inviteCard}>
              <div
                className={`${styles.inviteIcon} ${styles.inviteIconDanger}`}
              >
                <WebIcon name="alert" size={28} />
              </div>
              <h1 className={styles.title} style={{ marginBottom: 10 }}>
                Could not load invite
              </h1>
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                Error: {loadErr}. Try refreshing the page.
              </p>
            </div>
          )}

          {!sessionLoading && preview && preview.status === "expired" && (
            <div className={styles.inviteCard}>
              <div className={`${styles.inviteIcon} ${styles.inviteIconWarn}`}>
                <WebIcon name="clock" size={28} />
              </div>
              <h1 className={styles.title} style={{ marginBottom: 10 }}>
                This invite has expired
              </h1>
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                Ask{" "}
                <strong style={{ color: "var(--color-ink)" }}>
                  {preview.inviterEmail}
                </strong>{" "}
                to send a fresh one.
              </p>
            </div>
          )}

          {!sessionLoading && preview && preview.status === "accepted" && (
            <div className={styles.inviteCard}>
              <div className={styles.inviteIcon}>
                <WebIcon name="check" size={28} strokeWidth={2.2} />
              </div>
              <h1 className={styles.title} style={{ marginBottom: 10 }}>
                Already accepted
              </h1>
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                This invite was already accepted. Sign in to see the workspace.
              </p>
            </div>
          )}

          {!sessionLoading && preview && preview.status === "revoked" && (
            <div className={styles.inviteCard}>
              <div
                className={`${styles.inviteIcon} ${styles.inviteIconDanger}`}
              >
                <WebIcon name="alert" size={28} />
              </div>
              <h1 className={styles.title} style={{ marginBottom: 10 }}>
                Invite revoked
              </h1>
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                The owner revoked this invite. Ask them for a new one if you
                still want to join.
              </p>
            </div>
          )}

          {!sessionLoading && preview && preview.status === "pending" && (
            <div className={styles.inviteCard}>
              <div className={styles.inviteIcon}>
                <WebIcon name="users" size={28} />
              </div>
              <div className={styles.inviteFrom}>
                Invite from <strong>{preview.inviterEmail}</strong>
              </div>
              <h2 className={styles.inviteWsName}>{preview.workspaceName}</h2>
              <div className={styles.inviteRole}>
                You&apos;d join as
                <span
                  className={`${styles.pill} ${
                    preview.invitedRole === "editor"
                      ? styles.pillEditor
                      : styles.pillViewer
                  }`}
                >
                  <span className={styles.pillDot} />
                  {preview.invitedRole}
                </span>
              </div>

              {!session?.user && (
                <Link href={signInHref} className={styles.btn}>
                  Sign in to accept · {preview.invitedEmail}
                  <WebIcon name="arrowRight" size={16} strokeWidth={2} />
                </Link>
              )}

              {session?.user && preview.emailMatch === false && (
                <>
                  <div
                    className={`${styles.banner} ${styles.bannerDanger}`}
                    style={{ marginBottom: 18, textAlign: "left" }}
                  >
                    <span className={styles.bannerIcon}>
                      <WebIcon name="alert" size={18} />
                    </span>
                    <div className={styles.bannerBody}>
                      <div className={styles.bannerTitle}>Email mismatch</div>
                      <div className={styles.bannerSub}>
                        This invite is for{" "}
                        <strong>{preview.invitedEmail}</strong>. You&apos;re
                        signed in as <strong>{session.user.email}</strong>.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.btnOutlineFull}
                    onClick={() => signOut()}
                  >
                    Sign out and try again
                  </button>
                </>
              )}

              {session?.user && preview.emailMatch === true && (
                <AcceptButton token={params.token} />
              )}

              <div className={styles.inviteFoot}>
                By accepting, you&apos;ll get {preview.invitedRole} access to{" "}
                {preview.workspaceName}&apos;s transactions, categories, and
                budgets.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
