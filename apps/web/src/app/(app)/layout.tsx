import Link from "next/link";
import { WorkspaceSwitcher } from "./_components/workspace-switcher";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 24px",
          borderBottom: "1px solid #eee",
          fontFamily: "system-ui",
        }}
      >
        <nav style={{ display: "flex", gap: 16 }}>
          <Link href="/home" style={{ color: "inherit", textDecoration: "none" }}>
            Home
          </Link>
          <Link href="/settings/banks" style={{ color: "inherit", textDecoration: "none" }}>
            Banks
          </Link>
          <Link href="/settings/workspace" style={{ color: "inherit", textDecoration: "none" }}>
            Workspace
          </Link>
        </nav>
        <WorkspaceSwitcher />
      </header>
      {children}
    </div>
  );
}
