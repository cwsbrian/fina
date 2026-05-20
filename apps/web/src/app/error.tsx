"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        background: "var(--color-canvas)",
        color: "var(--color-ink)",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 500, letterSpacing: -0.8 }}>
        Something went wrong.
      </h1>
      <p style={{ color: "var(--color-muted)" }}>
        We hit a snag. Try again in a moment.
      </p>
      <button
        onClick={reset}
        style={{
          padding: "10px 20px",
          borderRadius: 999,
          background: "var(--color-ink)",
          color: "#fff",
          border: 0,
          font: "14px var(--font-inter)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  );
}
