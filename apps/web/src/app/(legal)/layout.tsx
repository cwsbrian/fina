import Link from "next/link";
import styles from "./legal.module.css";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Fina home">
          <img
            src="/images/logo-dark.png"
            alt="Fina"
            className={styles.brandLogo}
          />
        </Link>
        <nav className={styles.nav}>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/security">Security</Link>
        </nav>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <span>© Fina</span>
        <span>cwsbrian@gmail.com</span>
      </footer>
    </div>
  );
}
