import { z } from "zod";
import type { EmailInput } from "../email/send.js";

const DEFAULT_SUPPORT_TO = "building.intent@gmail.com";
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const AttachmentBody = z.object({
  filename: z.string().trim().min(1).max(160),
  contentType: z.string().trim().min(1).max(160).optional(),
  contentBase64: z.string().min(1),
});

export const SupportTicketBody = z.object({
  subject: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(5000),
  attachments: z.array(AttachmentBody).max(MAX_ATTACHMENTS).default([]),
});

export type SupportAttachmentInput = z.infer<typeof AttachmentBody>;
export type SupportTicketInput = z.infer<typeof SupportTicketBody>;

export function supportRecipients(value = DEFAULT_SUPPORT_TO): string[] {
  const recipients = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return recipients.length > 0 ? recipients : [DEFAULT_SUPPORT_TO];
}

function decodeBase64(value: string): Buffer {
  const raw = value.trim();
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error("invalid_attachment");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 0) throw new Error("invalid_attachment");
  return decoded;
}

export function validateSupportAttachments(
  attachments: SupportAttachmentInput[],
): NonNullable<EmailInput["attachments"]> {
  let total = 0;
  return attachments.map((a) => {
    const content = decodeBase64(a.contentBase64);
    if (content.length > MAX_ATTACHMENT_BYTES) throw new Error("invalid_attachment");
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("invalid_attachment");
    return {
      filename: a.filename,
      content,
      ...(a.contentType ? { contentType: a.contentType } : {}),
    };
  });
}

export function buildSupportEmail(input: SupportTicketInput & {
  user: { userId: string; email: string; name?: string | null };
  to?: string | string[];
}): EmailInput {
  const attachments = validateSupportAttachments(input.attachments);
  const who = input.user.name?.trim()
    ? `${input.user.name} <${input.user.email}>`
    : input.user.email;
  return {
    to: input.to ?? DEFAULT_SUPPORT_TO,
    subject: `[Fina support] ${input.subject}`,
    text:
      `From: ${who}\n` +
      `User ID: ${input.user.userId}\n\n` +
      `${input.message}\n`,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
