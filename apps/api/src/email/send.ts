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
    const message = result.error.message ?? JSON.stringify(result.error);
    // Resend sandbox / unverified-domain restrictions: the API key is valid
    // but the FROM domain is `onboarding@resend.dev` (or unverified). The
    // call fails for any recipient other than the account owner. We don't
    // want this to block the surrounding business action (invite created,
    // password reset row written, etc.) during dev — log the would-be email
    // and continue. In prod the right fix is to verify a domain on Resend.
    if (isSandboxRecipientRestriction(message) || isUnverifiedDomain(message)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[email fallback] Resend rejected (${shortReason(message)}). ` +
          `Logging below so you can copy the link manually. ` +
          `Verify a domain at resend.com/domains to fix.\n` +
          `[dev email] to=${input.to} subject="${input.subject}"\n${input.text}`,
      );
      return;
    }
    throw new Error(`Resend send failed: ${message}`);
  }
}

function isSandboxRecipientRestriction(msg: string): boolean {
  return /only send testing emails to your own email address/i.test(msg);
}

function isUnverifiedDomain(msg: string): boolean {
  return /domain is not verified/i.test(msg);
}

function shortReason(msg: string): string {
  if (isSandboxRecipientRestriction(msg)) return "sandbox: own email only";
  if (isUnverifiedDomain(msg)) return "unverified FROM domain";
  return msg.slice(0, 80);
}
