"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 16,
          padding: 24,
          background: "#f6f4ef",
          color: "#0a0b0d",
          fontFamily:
            "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 32, fontWeight: 500, letterSpacing: -0.8 }}>
          Something went wrong.
        </h1>
        <p style={{ color: "#7c828a" }}>
          We hit a snag. Try again in a moment.
        </p>
        <button
          onClick={reset}
          style={{
            padding: "10px 20px",
            borderRadius: 999,
            background: "#0a0b0d",
            color: "#fff",
            border: 0,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
