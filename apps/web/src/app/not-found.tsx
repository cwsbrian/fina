export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 8,
        padding: 24,
        background: "var(--color-canvas)",
        color: "var(--color-ink)",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 500, letterSpacing: -0.8 }}>
        Not found
      </h1>
      <p style={{ color: "var(--color-muted)" }}>
        That page doesn&apos;t exist (yet).
      </p>
    </main>
  );
}
