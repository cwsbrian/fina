import { pathToFileURL } from "node:url";
import { z } from "zod";

import { sendWelcomeEmail } from "../email/welcome.js";
import { loadRootEnv } from "./load-root-env.js";

loadRootEnv();

const Email = z.string().trim().toLowerCase().email();

function readFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function parseSendWelcomeEmailArgs(argv: string[]): {
  email: string;
  name?: string;
} {
  const rawEmail = readFlag(argv, "--email") ?? argv.find((value) => !value.startsWith("--"));
  const parsedEmail = Email.safeParse(rawEmail);
  if (!parsedEmail.success) {
    throw new Error(
      "Usage: pnpm --filter @fina/api admin:send-welcome-email -- --email user@example.com [--name \"Jane\"]",
    );
  }
  const name = readFlag(argv, "--name")?.trim();
  return {
    email: parsedEmail.data,
    ...(name ? { name } : {}),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseSendWelcomeEmailArgs(argv);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey === "re_...") {
    throw new Error("RESEND_API_KEY must be configured; no email was sent");
  }
  const from = process.env.EMAIL_FROM?.trim() || "Fina <no-reply@withfina.com>";
  await sendWelcomeEmail({ apiKey, from, ...input });
  console.log(`Welcome email sent to ${input.email}`);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
