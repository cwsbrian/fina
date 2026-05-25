import { sendEmail } from "./send.js";

export type SendInviteEmailInput = {
  apiKey: string | undefined;
  from: string;
  to: string;
  inviterEmail: string;
  inviterName: string | null;
  workspaceName: string;
  token: string;
  webAppUrl: string;
};

export async function sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
  const inviter = input.inviterName?.trim().length ? input.inviterName : input.inviterEmail;
  const link = `${input.webAppUrl.replace(/\/$/, "")}/invites/${encodeURIComponent(input.token)}`;
  const text =
    `${inviter} invited you to "${input.workspaceName}" on Fina.\n\n` +
    `Open this link to accept:\n${link}\n\n` +
    `This link expires in 7 days. If you weren't expecting this email, just ignore it.`;
  await sendEmail(input.apiKey, input.from, {
    to: input.to,
    subject: `${inviter} invited you to ${input.workspaceName} on Fina`,
    text,
  });
}
