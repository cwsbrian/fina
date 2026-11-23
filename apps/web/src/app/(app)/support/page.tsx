"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../../lib/api";
import styles from "../finance.module.css";

const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

async function encode(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read attachment."));
    reader.readAsDataURL(file);
  });
}

export default function SupportPage() {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!subject.trim() || !message.trim()) {
      setError("Enter a subject and message.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          contentType: file.type || undefined,
          contentBase64: await encode(file),
        })),
      );
      await apiFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), message: message.trim(), attachments }),
      });
      setSent(true);
      setFiles([]);
      setSubject("");
      setMessage("");
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not send support request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Contact support</h1>
          <p className={styles.sub}>Tell us what happened. We’ll reply by email.</p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {sent && (
        <div className={styles.notice} role="status">
          Request sent. We’ll reply by email.
        </div>
      )}
      <form className={styles.panel} onSubmit={submit}>
        <div className={styles.formGrid}>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label htmlFor="support-subject">Subject</label>
            <input
              className={styles.input}
              id="support-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={120}
              required
            />
          </div>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label htmlFor="support-message">Message</label>
            <textarea
              className={styles.input}
              id="support-message"
              rows={7}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={5000}
              required
            />
          </div>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <label htmlFor="support-files">
              Attachments (up to 3 files, 5 MB each, 10 MB total)
            </label>
            <input
              className={styles.input}
              id="support-files"
              type="file"
              multiple
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                if (
                  picked.length > MAX_FILES ||
                  picked.some((file) => file.size > MAX_FILE_BYTES) ||
                  picked.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES
                ) {
                  setError("Choose up to 3 files, 5 MB each and 10 MB total.");
                  event.target.value = "";
                  return;
                }
                setError(null);
                setFiles(picked);
              }}
            />
          </div>
          <div className={styles.formActions}>
            <button className={styles.button} type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send request"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
