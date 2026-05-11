import { Resend } from "resend";

let client: Resend | null = null;

function getClient(apiKey: string | undefined): Resend | null {
  // Treat empty + the .env.example placeholder ("re_...") as "not configured"
  // so dev/smoke without a real Resend key falls back to console logging
  // instead of attempting a real API call that returns 401 invalid-key.
  if (!apiKey || apiKey === "re_...") return null;
  if (!client) client = new Resend(apiKey);
  return client;
}

export type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(
  apiKey: string | undefined,
  from: string,
  input: EmailInput,
): Promise<void> {
  const c = getClient(apiKey);
  if (!c) {
    // Dev fallback: log so the magic link is still usable.
    // eslint-disable-next-line no-console
    console.log(`[dev email] to=${input.to} subject="${input.subject}"\n${input.text}`);
    return;
  }
  const result = await c.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html !== undefined ? { html: input.html } : {}),
  });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message ?? JSON.stringify(result.error)}`);
  }
}
