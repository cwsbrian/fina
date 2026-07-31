import type { EmailInput } from "./send.js";
import { sendEmail } from "./send.js";

type WelcomeUser = {
  email: string;
  name?: string | null;
};

export type SendWelcomeEmailInput = WelcomeUser & {
  apiKey: string | undefined;
  from: string;
};

function firstName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? (trimmed.split(/\s+/)[0] ?? null) : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildWelcomeEmail(user: WelcomeUser): EmailInput {
  const name = firstName(user.name);
  const greeting = name ? `Hi ${name},` : "Hi,";
  const htmlGreeting = escapeHtml(greeting);

  return {
    to: user.email,
    subject: "Welcome to Fina",
    text:
      `${greeting}\n\n` +
      `Welcome to Fina — we're so glad you're here.\n\n` +
      `We're always working to make Fina simpler, more useful, and a better experience for you. If something doesn't work as expected, you have feedback, or there's a feature you'd love to see, we'd genuinely like to hear from you.\n\n` +
      `Open Fina and go to More → Contact support anytime. Every message helps us make Fina better.\n\n` +
      `Thanks for being here,\nThe Fina team`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f7f6;color:#17211d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Welcome to Fina. We're glad you're here.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7f6;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e9e5;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:32px 36px 12px;font-size:25px;font-weight:700;letter-spacing:-0.7px;color:#17775b;">fina</td>
            </tr>
            <tr>
              <td style="padding:12px 36px 36px;font-size:16px;line-height:1.65;">
                <p style="margin:0 0 20px;">${htmlGreeting}</p>
                <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2;letter-spacing:-0.6px;color:#17211d;">Welcome to Fina.</h1>
                <p style="margin:0 0 18px;">We're so glad you're here.</p>
                <p style="margin:0 0 18px;">We're always working to make Fina simpler, more useful, and a better experience for you. If something doesn't work as expected, you have feedback, or there's a feature you'd love to see, we'd genuinely like to hear from you.</p>
                <div style="margin:26px 0;padding:18px 20px;background:#eef8f4;border-radius:12px;color:#174f3f;">
                  Open Fina and go to <strong>More → Contact support</strong> anytime. Every message helps us make Fina better.
                </div>
                <p style="margin:0;">Thanks for being here,<br><strong>The Fina team</strong></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

export async function sendWelcomeEmail(input: SendWelcomeEmailInput): Promise<void> {
  await sendEmail(input.apiKey, input.from, buildWelcomeEmail(input));
}
