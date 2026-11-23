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
      <h1 className="fi-title">Something went wrong.</h1>
      <p style={{ color: "var(--color-muted)" }}>
        We hit a snag. Try again in a moment.
      </p>
      <button onClick={reset} className="fi-btn fi-btn--primary">
        Try again
      </button>
    </main>
  );
}
