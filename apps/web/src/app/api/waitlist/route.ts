import { NextResponse } from "next/server";
import { z } from "zod";

// Landing waitlist signup. Sends a notification email via Resend to the
// operator (WAITLIST_TO). Intentionally NOT persisted — for v1 we just
// want to know who's interested.
//
// Server-side env (no NEXT_PUBLIC_ prefix — these never reach the browser):
//   RESEND_API_KEY  — required for the email send to actually fire.
//   WAITLIST_TO     — operator inbox; defaults to cwsbrian@gmail.com.
//   WAITLIST_FROM   — sender. Defaults to onboarding@resend.dev which
//                     works without domain verification but can only
//                     deliver to the Resend account owner's email.
//                     Once withfina.com is verified, switch to noreply@withfina.com.

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  let parsed: { email: string };
  try {
    const json = (await req.json()) as unknown;
    const result = Body.safeParse(json);
    if (!result.success) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.WAITLIST_TO ?? "cwsbrian@gmail.com";
  // Prefer the per-feature override (WAITLIST_FROM), then fall back to the
  // shared transactional sender (EMAIL_FROM, e.g. no-reply@withfina.com),
  // and finally Resend's sandbox sender for dev convenience.
  const emailFromShared = process.env.EMAIL_FROM
    ? `Fina <${process.env.EMAIL_FROM.replace(/^["']|["']$/g, "")}>`
    : null;
  const from =
    process.env.WAITLIST_FROM ?? emailFromShared ?? "Fina <onboarding@resend.dev>";

  if (!apiKey) {
    console.warn(
      `[waitlist] RESEND_API_KEY unset — cannot notify ${to} about ${parsed.email}`,
    );
    return NextResponse.json({ error: "email_not_configured" }, { status: 503 });
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `Fina · New waitlist signup`,
        text: `${parsed.email} joined the Fina waitlist.\n\nReply directly to reach them.`,
        reply_to: parsed.email,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[waitlist] Resend rejected (${res.status}) for ${parsed.email}: ${detail.slice(0, 200)}`,
      );
      return NextResponse.json({ error: "email_send_failed" }, { status: 502 });
    }
  } catch (e) {
    console.error(`[waitlist] Resend fetch failed for ${parsed.email}:`, e);
    return NextResponse.json({ error: "email_send_failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
