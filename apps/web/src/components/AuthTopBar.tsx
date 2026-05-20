"use client";

import { useRouter } from "next/navigation";
import styles from "./auth.module.css";

export function AuthTopBar({ homePath = "/" }: { homePath?: string }) {
  const router = useRouter();
  return (
    <div className={styles.top}>
      <button
        type="button"
        className={styles.brand}
        onClick={() => router.push(homePath)}
      >
        <span className={styles.brandMark}>F</span>
        <span className={styles.brandWord}>Fina</span>
      </button>
      <div className={styles.topMeta}>Made in Canada · CAD</div>
    </div>
  );
}
