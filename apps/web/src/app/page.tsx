"use client";
import Link from "next/link";
import { useSession } from "../auth/client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Landing() {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (data?.user) router.replace("/home");
  }, [data, router]);

  if (isPending) return null;
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 48, marginBottom: 16 }}>Fina</h1>
      <p style={{ fontSize: 18, opacity: 0.7, marginBottom: 32 }}>
        AI Financial Advisor — chat with your money.
      </p>
      <Link
        href="/sign-in"
        style={{
          display: "inline-block",
          background: "#111",
          color: "#fff",
          padding: "12px 24px",
          borderRadius: 8,
          textDecoration: "none",
        }}
      >
        Sign in
      </Link>
    </main>
  );
}
