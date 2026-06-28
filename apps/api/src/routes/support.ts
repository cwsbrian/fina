import type { FastifyInstance } from "fastify";
import { HttpError, requireSession } from "../auth/context.js";
import { sendEmail } from "../email/send.js";
import { buildSupportEmail, supportRecipients, SupportTicketBody } from "../support/email.js";

export async function supportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/support/tickets", { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const parsed = SupportTicketBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const session = await requireSession(req, app);
      const email = buildSupportEmail({
        ...parsed.data,
        user: session,
        to: supportRecipients(app.fina.env.SUPPORT_EMAIL_TO),
      });
      await sendEmail(app.fina.env.RESEND_API_KEY, app.fina.env.EMAIL_FROM, email);
      return reply.code(201).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      if (e instanceof Error && e.message === "invalid_attachment") {
        return reply.code(400).send({ error: "invalid_body" });
      }
      app.log.error({ err: e }, "support email send failed");
      return reply.code(502).send({ error: "email_send_failed" });
    }
  });
}
